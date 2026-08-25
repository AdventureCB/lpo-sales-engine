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

  const participants = (await listConversationParticipants({ phoneNumberId, updatedAfter: createdAfter })).sort();

  if (probe) {
    const sample = participants.slice(0, 3);
    const raw = await quoPool(sample, (p) =>
      quoGet("/messages", { phoneNumberId, participants: p, maxResults: "3" }).catch((e) => ({ error: String(e) }))
    );
    return NextResponse.json({ ok: true, participants: participants.length, sample, raw });
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
  let i = offset;
  for (; i < participants.length; i++) {
    if (Date.now() - started > 42_000) break; // leave room to respond; resume via ?offset=
    const peer = participants[i];
    let pageToken: string | null = null;
    do {
      const params: Record<string, string> = { phoneNumberId, participants: peer, maxResults: "100", createdAfter };
      if (pageToken) params.pageToken = pageToken;
      const page = await quoGet("/messages", params).catch(() => null);
      if (!page) break;
      for (const m of page.data ?? []) {
        scanned++;
        const mediaUrls: string[] = (Array.isArray(m.media) ? m.media : [])
          .map((x: any) => (typeof x === "string" ? x : x?.url))
          .filter(Boolean);
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
            ...(mirrored.length ? { media: mirrored } : {}),
            sent_at: m.createdAt ?? null,
          },
          { onConflict: "provider,provider_message_id", ignoreDuplicates: false }
        );
        if (!error) imported++;
      }
      pageToken = page.nextPageToken ?? null;
      if (pageToken) await new Promise((r) => setTimeout(r, 150));
    } while (pageToken && Date.now() - started < 42_000);
  }

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
