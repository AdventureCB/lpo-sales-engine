import type { SupabaseClient } from "@supabase/supabase-js";
import { pageLabel } from "./web-activity";

/**
 * Website behavior → marketing signals. Distills each identified visitor's
 * site session (web_events via web_visitor_links) into engagement_events rows
 * with source "site", so the hot list, sprint-list tiers and campaign
 * triggers see site activity through the same path as Klaviyo/Shopify
 * signals. Type names are chosen to fit the existing rules:
 *
 *   active_on_site   session with ≥60s active time or ≥3 pages   (sprint 1b)
 *   viewed_product   camper product/overview page ≥10s           (sprint 1b)
 *   viewed_builder   3D builder page or link                      (sprint 1b "builder")
 *   viewed_financing financing page ≥10s                         (sprint 1b "financ")
 *   watched_video    a video past 50%
 *   phone_click      tapped a phone number                        (hot list: "*click" = hot)
 *   booking_click    clicked a booking / demo link                (hot list + sprint 1a)
 *   cart_click       clicked reserve / deposit / add to cart / pay (hot list + sprint 1a)
 *
 * One row per session per type; idempotent through the table's unique
 * (source, type, person_email, occurred_at).
 */

const PRODUCT = new Set(["Camper product page", "Camper overview"]);
const CART_RE = /deposit|reserve|add to cart|buy now|checkout|pay\b|order now|place order/i;
const BOOK_RE = /book\.lonepeakoverland\.com|calendly|\/pages\/(demo|book|schedule)/i;

type Row = { source: "site"; type: string; person_email: string; occurred_at: string; meta: Record<string, unknown> };

export async function syncWebSignals(
  db: SupabaseClient,
  opts: { sinceHours?: number; visitorIds?: string[] } = {}
): Promise<{ sessions: number; signals: number; inserted: number }> {
  const since = new Date(Date.now() - (opts.sinceHours ?? 48) * 3_600_000).toISOString();
  let q = db
    .from("web_events")
    .select("visitor_id, session_id, at, type, path, title, duration_s, name, detail")
    .order("at")
    .limit(20000);
  q = opts.visitorIds?.length ? q.in("visitor_id", opts.visitorIds).gte("at", since) : q.gte("created_at", since);
  const { data: events, error } = await q;
  if (error) throw new Error(error.message);
  if (!events?.length) return { sessions: 0, signals: 0, inserted: 0 };

  // Only identified visitors produce signals.
  const vids = Array.from(new Set(events.map((e: any) => e.visitor_id)));
  const emailsByVid = new Map<string, Set<string>>();
  for (let i = 0; i < vids.length; i += 200) {
    const { data: links } = await db.from("web_visitor_links").select("visitor_id, email").in("visitor_id", vids.slice(i, i + 200));
    for (const l of links ?? []) {
      const e = String(l.email ?? "").toLowerCase();
      if (!e) continue;
      (emailsByVid.get(l.visitor_id) ?? emailsByVid.set(l.visitor_id, new Set()).get(l.visitor_id)!).add(e);
    }
  }

  // Fold per session.
  type Sess = { vid: string; start: string; active: number; pages: { label: string; at: string; dwell: number }[]; ix: any[] };
  const sessions = new Map<string, Sess>();
  for (const e of events as any[]) {
    if (!emailsByVid.has(e.visitor_id)) continue;
    const s = sessions.get(e.session_id) ?? sessions.set(e.session_id, { vid: e.visitor_id, start: e.at, active: 0, pages: [], ix: [] }).get(e.session_id)!;
    if (e.at < s.start) s.start = e.at;
    const label = pageLabel(e.path, e.title);
    if (e.type === "pageview") s.pages.push({ label, at: e.at, dwell: 0 });
    else if (e.type === "pageend") {
      const p = [...s.pages].reverse().find((x) => x.label === label) ?? (s.pages.push({ label, at: e.at, dwell: 0 }), s.pages[s.pages.length - 1]);
      p.dwell += e.duration_s ?? 0;
      s.active += e.duration_s ?? 0;
    } else if (e.type === "interaction") s.ix.push(e);
  }

  const rows: Row[] = [];
  for (const [sid, s] of sessions) {
    const emails = Array.from(emailsByVid.get(s.vid) ?? []);
    const out = new Map<string, Row>(); // type → row (first occurrence wins)
    const emit = (type: string, at: string, meta: Record<string, unknown> = {}) => {
      if (out.has(type)) return;
      out.set(type, { source: "site", type, person_email: "", occurred_at: at, meta: { session_id: sid, ...meta } });
    };
    if (s.active >= 60 || s.pages.length >= 3) {
      emit("active_on_site", s.start, { pages: s.pages.length, active_s: s.active, top: s.pages.filter((p) => p.dwell >= 5).map((p) => p.label).slice(0, 5) });
    }
    for (const p of s.pages) {
      if (PRODUCT.has(p.label) && p.dwell >= 10) emit("viewed_product", p.at, { page: p.label, dwell_s: p.dwell });
      if (p.label === "3D builder") emit("viewed_builder", p.at, { dwell_s: p.dwell });
      if (p.label === "Financing" && p.dwell >= 10) emit("viewed_financing", p.at, { dwell_s: p.dwell });
    }
    for (const i of s.ix) {
      const d = String(i.detail ?? "");
      if (i.name === "tel") emit("phone_click", i.at, { number: d });
      else if (i.name === "video" && /50%|complete/.test(d)) emit("watched_video", i.at, { video: d });
      else if ((i.name === "outbound" || i.name === "link") && BOOK_RE.test(d)) emit("booking_click", i.at, { link: d });
      else if (i.name === "link" && /build/i.test(d)) emit("viewed_builder", i.at, { link: d });
      else if (i.name === "click" && CART_RE.test(d)) emit("cart_click", i.at, { button: d });
    }
    for (const r of out.values()) for (const email of emails) rows.push({ ...r, person_email: email });
  }
  if (!rows.length) return { sessions: sessions.size, signals: 0, inserted: 0 };

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error: upErr } = await db
      .from("engagement_events")
      .upsert(chunk, { onConflict: "source,type,person_email,occurred_at", ignoreDuplicates: true })
      .select("id");
    if (upErr) throw new Error(upErr.message);
    inserted += data?.length ?? 0;
  }
  return { sessions: sessions.size, signals: rows.length, inserted };
}
