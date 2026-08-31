import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { env } from "@/lib/env";
import { listConversationParticipants, quoPool } from "@/lib/quo-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUO_BASE = "https://api.quo.com/v1";

/**
 * One-time pre-decommission import: full Quo message history (incl. MMS
 * media, which the webhook never captured) for a line, into sms_messages.
 * Media is mirrored into the comm-media bucket with 10-year signed URLs —
 * Quo's own URLs die with the account.
 *
 * ?number=+1509…   line to import (required)
 * ?days=N          lookback window (default 400)
 * ?probe=1         return 3 raw message objects (shape check), write nothing
 * ?offset=N        skip the first N participants (resume after 60s cap)
 * ?dry=1           count only, no writes
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const number = u.searchParams.get("number");
  if (!number) return NextResponse.json({ error: "?number= required" }, { status: 400 });
  const days = Math.min(Number(u.searchParams.get("days") ?? 400), 1000);
  const probe = u.searchParams.get("probe") === "1";
  const dry = u.searchParams.get("dry") === "1";
  const offset = Number(u.searchParams.get("offset") ?? 0);
  const started = Date.now();
  const db = supabaseAdmin();

  const { data: rep } = await db
    .from("reps")
    .select("id, name, quo_phone_number_id, quo_user_id")
    .or(`quo_phone_number.eq.${number},telnyx_number.eq.${number}`)
    .maybeSingle();
  const phoneNumberId = rep?.quo_phone_number_id ?? u.searchParams.get("pnid");
  if (!phoneNumberId) return NextResponse.json({ error: `no quo_phone_number_id for ${number}; pass ?pnid=` }, { status: 400 });

  const createdAfter = new Date(Date.now() - days * 86400_000).toISOString();
  const quoGet = async (path: string, params: Record<string, string | string[]>) => {
    const url = new URL(`${QUO_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) for (const it of Array.isArray(v) ? v : [v]) url.searchParams.append(k, it);
    const r = await fetch(url, { headers: { Authorization: env("QUO_API_KEY"), "User-Agent": "lpo-sales-engine/0.1" } });
    if (!r.ok) throw new Error(`Quo ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  // ?msgid=AC… — raw message detail from Quo (list-vs-detail media check)
  // ?msgid=AC…&mirror=1 — also mirror that message's media (30MB cap vs the
  // bulk importer's 12MB) and stamp it onto the existing sms_messages row
  const msgid = u.searchParams.get("msgid");
  if (msgid) {
    const detail: any = await quoGet(`/messages/${encodeURIComponent(msgid)}`, {}).catch((e) => ({ error: String(e) }));
    if (u.searchParams.get("mirror") !== "1") return NextResponse.json({ ok: true, msgid, detail });
    const mediaArr = Array.isArray(detail?.media) ? detail.media : Array.isArray(detail?.data?.media) ? detail.data.media : [];
    const urls: string[] = mediaArr.map((x: any) => (typeof x === "string" ? x : x?.url)).filter(Boolean);
    const mirrored: string[] = [];
    for (const src of urls.slice(0, 5)) {
      try {
        const res = await fetch(src, { headers: { "User-Agent": "lpo-sales-engine/0.1" } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 30 * 1024 * 1024) continue;
        const ct = res.headers.get("content-type") ?? "application/octet-stream";
        const ext = (ct.split("/")[1] ?? "bin").replace("jpeg", "jpg").split(";")[0].slice(0, 5);
        const path = `quo-import/${crypto.randomUUID()}.${ext}`;
        const { error } = await db.storage.from("comm-media").upload(path, buf, { contentType: ct });
        if (error) continue;
        const { data: signed } = await db.storage.from("comm-media").createSignedUrl(path, 10 * 365 * 24 * 3600);
        if (signed?.signedUrl) mirrored.push(signed.signedUrl);
      } catch {
        /* skip file */
      }
    }
    let updated = false;
    if (mirrored.length) {
      const { error } = await db
        .from("sms_messages")
        .update({ media: mirrored })
        .eq("provider", "quo")
        .eq("provider_message_id", msgid);
      updated = !error;
    }
    return NextResponse.json({ ok: true, msgid, mediaUrls: urls.length, mirrored: mirrored.length, updated });
  }

  // ?convs=1 — list conversations with participant counts (group-thread probe)
  if (u.searchParams.get("convs") === "1") {
    const convs: any[] = [];
    let pt: string | null = null;
    do {
      const params: Record<string, string> = { "phoneNumbers[]": phoneNumberId, updatedAfter: createdAfter, maxResults: "100" };
      if (pt) params.pageToken = pt;
      const page: any = await quoGet("/conversations", params);
      convs.push(...(page.data ?? []));
      pt = page.nextPageToken ?? null;
    } while (pt && Date.now() - started < 45_000);
    const groups = convs.filter((c) => (c.participants ?? []).length > 1);
    return NextResponse.json({
      ok: true,
      conversations: convs.length,
      groupThreads: groups.length,
      groupSample: groups.slice(0, 10).map((c) => ({ id: c.id, participants: c.participants, lastActivityAt: c.lastActivityAt ?? c.updatedAt })),
    });
  }

  const participants = (await listConversationParticipants({ phoneNumberId, updatedAfter: createdAfter })).sort();

  if (probe) {
    const sample = participants.slice(0, 3);
    const raw = await quoPool(sample, (p) =>
      quoGet("/messages", { phoneNumberId, participants: p, maxResults: "3" }).catch((e) => ({ error: String(e) }))
    );
    return NextResponse.json({ ok: true, participants: participants.length, sample, raw });
  }

  // ?audit=1 — no writes: list every in-window message Quo says has media,
  // whether our row has it, and whether the media URL actually downloads.
  if (u.searchParams.get("audit") === "1") {
    const findings: any[] = [];
    for (let a = 0; a < participants.length; a += 6) {
      if (Date.now() - started > 45_000) break;
      await Promise.all(
        participants.slice(a, a + 6).map(async (peer) => {
          let pageToken: string | null = null;
          do {
            const params: Record<string, string> = { phoneNumberId, participants: peer, maxResults: "100", createdAfter };
            if (pageToken) params.pageToken = pageToken;
            const page: any = await quoGet("/messages", params).catch(() => null);
            if (!page) return;
            for (const m of page.data ?? []) {
              const urls: string[] = (Array.isArray(m.media) ? m.media : [])
                .map((x: any) => (typeof x === "string" ? x : x?.url))
                .filter(Boolean);
              if (!urls.length) continue;
              const { data: row } = await db
                .from("sms_messages")
                .select("id, media")
                .eq("provider", "quo")
                .eq("provider_message_id", m.id)
                .maybeSingle();
              const dbHasMedia = !!row?.media && JSON.stringify(row.media) !== "[]";
              let fetchStatus: number | string = "skipped";
              if (!dbHasMedia) {
                try {
                  const h = await fetch(urls[0], { headers: { "User-Agent": "lpo-sales-engine/0.1" } });
                  fetchStatus = h.status;
                  const len = Number(h.headers.get("content-length") ?? 0);
                  if (h.ok && len > 12 * 1024 * 1024) fetchStatus = `too-big:${len}`;
                } catch (e) {
                  fetchStatus = `err:${String(e).slice(0, 80)}`;
                }
              }
              findings.push({ id: m.id, peer, createdAt: m.createdAt, mediaCount: urls.length, inDb: !!row, dbHasMedia, fetchStatus });
            }
            pageToken = page.nextPageToken ?? null;
          } while (pageToken && Date.now() - started < 45_000);
        })
      );
    }
    const missing = findings.filter((f) => !f.dbHasMedia);
    return NextResponse.json({ ok: true, audit: true, days, mediaMessages: findings.length, missing: missing.length, detail: missing.slice(0, 40), okSample: findings.filter((f) => f.dbHasMedia).length });
  }

  const mirrorMedia = async (urls: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const src of urls.slice(0, 5)) {
      try {
        const res = await fetch(src, { headers: { "User-Agent": "lpo-sales-engine/0.1" } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 12 * 1024 * 1024) continue;
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        const ext = (ct.split("/")[1] ?? "jpg").replace("jpeg", "jpg").split(";")[0].slice(0, 5);
        const path = `quo-import/${crypto.randomUUID()}.${ext}`;
        const { error } = await db.storage.from("comm-media").upload(path, buf, { contentType: ct });
        if (error) continue;
        const { data: signed } = await db.storage.from("comm-media").createSignedUrl(path, 10 * 365 * 24 * 3600);
        if (signed?.signedUrl) out.push(signed.signedUrl);
      } catch {
        /* skip file */
      }
    }
    return out;
  };

  let imported = 0;
  let mediaMsgs = 0;
  let mediaFiles = 0;
  let scanned = 0;

  const importPeer = async (peer: string) => {
    let pageToken: string | null = null;
    do {
      const params: Record<string, string> = { phoneNumberId, participants: peer, maxResults: "100", createdAfter };
      if (pageToken) params.pageToken = pageToken;
      const page = await quoGet("/messages", params).catch(() => null);
      if (!page) break;
      // One media-state lookup per PAGE (not per message) — a several-
      //-thousand-message thread must skim already-checked rows in
      // milliseconds or it can never finish inside the 60s function cap.
      const pageIds = (page.data ?? []).map((m: any) => m.id).filter(Boolean);
      const mediaState = new Map<string, unknown>();
      if (pageIds.length) {
        const { data: existingRows } = await db
          .from("sms_messages")
          .select("provider_message_id, media")
          .eq("provider", "quo")
          .in("provider_message_id", pageIds);
        for (const r of existingRows ?? []) mediaState.set(r.provider_message_id as string, r.media);
      }
      for (const m of page.data ?? []) {
        if (Date.now() - started > 50_000) return false; // hard stop before Vercel's 60s kill; markers make resume cheap
        scanned++;
        // Fully processed already (media mirrored or detail-checked empty) —
        // never re-mirror: retries were re-downloading list-supplied media
        // every pass and starving giant threads of their time budget.
        if (mediaState.get(m.id) != null) continue;
        let mediaUrls: string[] = (Array.isArray(m.media) ? m.media : [])
          .map((x: any) => (typeof x === "string" ? x : x?.url))
          .filter(Boolean);
        // The LIST endpoint silently strips media on some messages (verified
        // live: detail had 2 jpegs where list said []). When the list shows
        // none, ask the detail endpoint — unless the row was already checked:
        // media NULL = never checked, [] = detail-checked and empty, [urls…]
        // = mirrored. The [] marker keeps giant threads from re-checking every
        // message on each resume.
        let checkedEmpty = false;
        if (!mediaUrls.length) {
          if (mediaState.has(m.id) && mediaState.get(m.id) != null) continue; // mirrored or checked-empty; row already imported
          const det: any = await quoGet(`/messages/${encodeURIComponent(m.id)}`, {}).catch(() => null);
          mediaUrls = (Array.isArray(det?.data?.media) ? det.data.media : [])
            .map((x: any) => (typeof x === "string" ? x : x?.url))
            .filter(Boolean);
          checkedEmpty = det != null && !mediaUrls.length;
          await new Promise((r) => setTimeout(r, 60));
        }
        if (dry) {
          if (mediaUrls.length) mediaMsgs++;
          continue;
        }
        const mirrored = mediaUrls.length ? await mirrorMedia(mediaUrls) : [];
        if (mirrored.length) {
          mediaMsgs++;
          mediaFiles += mirrored.length;
        }
        const to0 = Array.isArray(m.to) ? m.to[0] : m.to;
        const { error } = await db.from("sms_messages").upsert(
          {
            provider: "quo",
            provider_message_id: m.id,
            rep_id: rep?.id ?? null,
            direction: m.direction ?? null,
            status: m.status ?? null,
            phone_number_id: m.phoneNumberId ?? phoneNumberId,
            our_number: (m.direction === "incoming" ? to0 : m.from) ?? number,
            peer_phone: peer,
            body: m.body ?? m.text ?? null,
            ...(mirrored.length ? { media: mirrored } : checkedEmpty ? { media: [] } : {}),
            sent_at: m.createdAt ?? null,
          },
          { onConflict: "provider,provider_message_id", ignoreDuplicates: false }
        );
        if (!error) imported++;
      }
      pageToken = page.nextPageToken ?? null;
      if (pageToken) await new Promise((r) => setTimeout(r, 150));
    } while (pageToken);
    return true;
  };

  // 3 peers at a time — detail-endpoint calls added per message, stay under Quo's 10/s.
  let i = offset;
  for (; i < participants.length; ) {
    if (Date.now() - started > 42_000) break; // leave room to respond; resume via ?offset=
    const results = await Promise.all(participants.slice(i, i + 3).map((p) => importPeer(p)));
    if (results.some((r) => r === false)) break; // a peer was cut mid-thread — retry this batch next run
    i += 3;
  }
  i = Math.min(i, participants.length);

  return NextResponse.json({
    ok: true,
    number,
    participants: participants.length,
    processedThrough: i,
    done: i >= participants.length,
    nextOffset: i >= participants.length ? null : i,
    scanned,
    imported,
    mediaMsgs,
    mediaFiles,
    dry,
  });
}
