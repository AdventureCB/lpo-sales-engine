import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { computeLeadCost } from "@/lib/lead-cost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin-only ad ROI: per-channel spend / leads / CPL / won value + blended CAC. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 30) || 30, 7), 180);
  const db = supabaseAdmin();
  const report = await computeLeadCost(db, days);

  // First-party beacon freshness — the pipeline is fail-silent by design, so
  // this line is how a dead beacon gets noticed (it once 401'd for 2 weeks).
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ data: lastTouch }, { count: touches24h }, { count: links }] = await Promise.all([
    db.from("web_touches").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("web_touches").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
    db.from("web_visitor_links").select("visitor_id", { count: "exact", head: true }),
  ]);
  // The linked-visitor roster — who the beacon has identified, so "N linked
  // visitors" is investigable instead of just a number.
  const { data: linkRows } = await db
    .from("web_visitor_links")
    .select("visitor_id, email, linked_at")
    .order("linked_at", { ascending: false })
    .limit(50);
  const vids = (linkRows ?? []).map((l) => l.visitor_id);
  const emails = [...new Set((linkRows ?? []).map((l) => String(l.email).toLowerCase()))];
  const [{ data: touchRows }, { data: contactRows }] = await Promise.all([
    vids.length
      ? db
          .from("web_touches")
          .select("visitor_id, at, source, medium, campaign, landing, gclid, fbclid")
          .in("visitor_id", vids)
          .order("at", { ascending: true })
          .limit(2000)
      : Promise.resolve({ data: [] as any[] }),
    emails.length
      ? db.from("crm_contacts").select("id, name, emails").in("emails->0->>value", emails)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const contactByEmail = new Map<string, { id: string; name: string | null }>();
  for (const c of contactRows ?? []) {
    const e = String((c.emails as any)?.[0]?.value ?? "").toLowerCase();
    if (e) contactByEmail.set(e, { id: c.id, name: c.name });
  }
  const contactIds = [...new Set([...contactByEmail.values()].map((c) => c.id))];
  const { data: dealRows } = contactIds.length
    ? await db.from("crm_deals").select("id, contact_id, title, status").in("contact_id", contactIds).order("created_at", { ascending: false })
    : { data: [] as any[] };
  // Prefer an open deal; otherwise the newest of any status.
  const dealByContact = new Map<string, { id: string; title: string; status: string }>();
  for (const d of dealRows ?? []) {
    const cur = dealByContact.get(d.contact_id);
    if (!cur || (d.status === "open" && cur.status !== "open")) {
      dealByContact.set(d.contact_id, { id: d.id, title: d.title, status: d.status });
    }
  }
  const touchesByVid = new Map<string, any[]>();
  for (const t of touchRows ?? []) {
    const arr = touchesByVid.get(t.visitor_id) ?? [];
    arr.push(t);
    touchesByVid.set(t.visitor_id, arr);
  }
  const visitors = (linkRows ?? []).map((l) => {
    const ts = touchesByVid.get(l.visitor_id) ?? [];
    const first = ts[0] ?? null;
    const lastPaid = [...ts].reverse().find((t) => t.source || t.gclid || t.fbclid) ?? null;
    const contact = contactByEmail.get(String(l.email).toLowerCase()) ?? null;
    const deal = contact ? dealByContact.get(contact.id) ?? null : null;
    return {
      email: l.email,
      linkedAt: l.linked_at,
      contactName: contact?.name ?? null,
      dealId: deal?.id ?? null,
      dealTitle: deal?.title ?? null,
      touches: ts.length,
      firstAt: first?.at ?? null,
      firstSource: first ? first.source ?? (first.gclid ? "google (gclid)" : first.fbclid ? "facebook (fbclid)" : null) : null,
      firstLanding: first?.landing ?? null,
      lastSource: lastPaid ? lastPaid.source ?? (lastPaid.gclid ? "google (gclid)" : lastPaid.fbclid ? "facebook (fbclid)" : null) : null,
      lastCampaign: lastPaid?.campaign ?? null,
    };
  });

  return NextResponse.json({
    ...report,
    beacon: { lastAt: lastTouch?.created_at ?? null, touches24h: touches24h ?? 0, linkedVisitors: links ?? 0 },
    visitors,
  });
}
