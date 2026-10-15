import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email-only list: a rep's OPEN deals whose contact has an email but no usable
 * phone — they never reach the dialer or sprint lists, so they went untouched
 * (979 such deals on 10/15). Ranked like a sprint list: freshest marketing
 * signal first, then recent activity. Each row carries when the rep last
 * emailed them and any campaign they're in, so "worked today" is visible.
 *
 *   GET ?rep=<email> (admin) · ?pool=1 (unassigned instead of mine)
 *   POST { op: "snooze", dealIds, days }   — reuses crm_deals.sprint_snooze_until
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const p = new URL(req.url).searchParams;
  const pool = p.get("pool") === "1";
  let repEmail = user.email;
  if (p.get("rep") && user.role === "admin") repEmail = p.get("rep")!;
  const { data: rep } = await db.from("reps").select("pipedrive_user_id, name").eq("email", repEmail).maybeSingle();
  if (!pool && !rep?.pipedrive_user_id) return NextResponse.json({ items: [], rep: repEmail });

  const todayLa = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  let q = db
    .from("crm_deals")
    .select("id, title, created_at, last_activity_at, attempt_count, contact_count, sprint_snooze_until, deal_sources ( name ), crm_stages ( name, crm_pipelines ( name ) ), crm_contacts ( id, name, emails, phones, dnc, email_unsub )")
    .eq("status", "open")
    .or(`sprint_snooze_until.is.null,sprint_snooze_until.lt.${todayLa}`)
    .limit(2000);
  q = pool ? q.is("owner_pipedrive_id", null) : q.eq("owner_pipedrive_id", rep!.pipedrive_user_id);
  const { data: deals, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Email, no usable phone, not DNC / unsubscribed.
  const rows = (deals ?? []).filter((d: any) => {
    const c = d.crm_contacts;
    if (!c || c.dnc || c.email_unsub) return false;
    const email = (c.emails ?? []).find((e: any) => e?.value)?.value;
    const phone = (c.phones ?? []).some((p: any) => p && !p.bad && (p.e164 || p.value));
    return !!email && !phone;
  });
  if (!rows.length) return NextResponse.json({ items: [], rep: repEmail, pool });

  const emailOf = (d: any): string => String(((d.crm_contacts?.emails ?? []).find((e: any) => e?.primary && e?.value) ?? d.crm_contacts.emails[0]).value).toLowerCase();
  const emails = [...new Set(rows.map(emailOf))];
  const dealIds = rows.map((d: any) => d.id);

  // Latest marketing signal per email (same aggregate the sprint lists use).
  const { data: sig } = await db.rpc("engagement_latest_signals", { p_hot_regex: "(cart|checkout|builder_save|save.?build|3d.?build|abandon|booking_click|cart_click)|(click|viewed_product|active_on_site|form|subscrib|builder|3d|order|financ|video)" });
  const latest = new Map<string, { latest: string; hot: string | null }>();
  for (const r of (sig ?? []) as any[]) if (emails.includes(r.email)) latest.set(r.email, { latest: r.latest, hot: r.latest_hot });

  // Last outbound email per deal (any rep) + campaign enrollment.
  const [{ data: mails }, { data: enrs }] = await Promise.all([
    db.from("crm_activities").select("deal_id, occurred_at, actor").eq("type", "email").in("deal_id", dealIds).neq("meta->>direction", "inbound").order("occurred_at", { ascending: false }).limit(5000),
    db.from("campaign_enrollments").select("deal_id, status, campaigns ( name )").in("deal_id", dealIds).eq("status", "active"),
  ]);
  const lastMail = new Map<string, { at: string; by: string | null }>();
  for (const m of mails ?? []) if (!lastMail.has(m.deal_id)) lastMail.set(m.deal_id, { at: m.occurred_at, by: m.actor });
  const camp = new Map<string, string>();
  for (const e of (enrs ?? []) as any[]) camp.set(e.deal_id, e.campaigns?.name ?? "campaign");

  const items = rows
    .map((d: any) => {
      const email = emailOf(d);
      const s = latest.get(email);
      return {
        dealId: d.id,
        title: d.title,
        personName: d.crm_contacts?.name ?? null,
        email,
        source: d.deal_sources?.name ?? null,
        stage: d.crm_stages?.name ?? null,
        pipeline: d.crm_stages?.crm_pipelines?.name ?? null,
        createdAt: d.created_at,
        lastActivityAt: d.last_activity_at,
        lastSignalAt: s?.latest ?? null,
        lastHotAt: s?.hot ?? null,
        lastEmailAt: lastMail.get(d.id)?.at ?? null,
        lastEmailBy: lastMail.get(d.id)?.by ?? null,
        campaign: camp.get(d.id) ?? null,
        attempts: d.attempt_count ?? 0,
      };
    })
    .sort((a, b) => {
      // Hot signal first, then latest signal, then recent activity, then newest.
      const ah = a.lastHotAt ?? "", bh = b.lastHotAt ?? "";
      if (ah !== bh) return bh.localeCompare(ah);
      const as = a.lastSignalAt ?? "", bs = b.lastSignalAt ?? "";
      if (as !== bs) return bs.localeCompare(as);
      return (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt);
    });
  return NextResponse.json({ items, rep: repEmail, repName: rep?.name ?? null, pool, today: todayLa });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body.op !== "snooze" || !Array.isArray(body.dealIds) || !body.dealIds.length) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const days = Math.max(1, Math.min(90, Number(body.days) || 7));
  const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const db = supabaseAdmin();
  let q = db.from("crm_deals").update({ sprint_snooze_until: until, updated_at: new Date().toISOString() }).in("id", body.dealIds.slice(0, 200));
  if (user.role !== "admin") {
    // Reps only snooze their own (owner is keyed by Pipedrive user id).
    const { data: rep } = await db.from("reps").select("pipedrive_user_id").eq("email", user.email).maybeSingle();
    if (!rep?.pipedrive_user_id) return NextResponse.json({ error: "no rep" }, { status: 403 });
    q = q.eq("owner_pipedrive_id", rep.pipedrive_user_id);
  }
  const { error } = await q;
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });
  return NextResponse.json({ ok: true, until });
}
