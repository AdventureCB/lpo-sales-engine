import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Website activity for a contact: raw web_events (attr.js v2) for every
 * visitor id linked to the contact's emails, folded into sessions → pages →
 * interactions, plus a one-line summary for the deal header and a compact
 * brief for the AI inputs. Visitors link on identify, so earlier anonymous
 * visits appear retroactively.
 */

export interface WebPage {
  path: string;
  title: string | null;
  at: string;
  durationS: number;
  scrollPct: number | null;
  sections: string[];
  interactions: { at: string; name: string; detail: string | null }[];
}

export interface WebSession {
  id: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
  pages: WebPage[];
  source: string | null; // "Meta ad · retargeting", "Google ad", "google.com", "direct"
  device: string | null;
}

export interface WebActivity {
  summary: string; // "4 visits · 38 min · last Tue 3:12 PM"
  visits: number;
  totalS: number;
  lastSeenAt: string | null;
  firstSeenAt: string | null;
  topPages: { path: string; title: string | null; views: number; durationS: number }[];
  sessions: WebSession[]; // newest first
  brief: string; // multi-line, for AI inputs
}

const PAGE_LABEL: [RegExp, string][] = [
  [/\/pages\/.*financ|synchrony/i, "Financing"],
  [/\/products\/lone-peak-camper/i, "Camper product page"],
  [/\/pages\/lone-peak-camper/i, "Camper overview"],
  [/\/pages\/(3d-)?build/i, "3D builder"],
  [/\/blogs\/customer-build-gallery/i, "Customer build gallery"],
  [/\/pages\/demo|\/pages\/book|\/pages\/schedule/i, "Demo / booking"],
  [/\/pages\/faq/i, "FAQ"],
  [/\/pages\/specs|specifications/i, "Specs"],
  [/\/pages\/contact/i, "Contact"],
  [/\/collections\//i, "Collection"],
  [/\/cart|\/checkout/i, "Cart / checkout"],
  [/^\/$/, "Home"],
];

export function pageLabel(path: string | null, title: string | null): string {
  const p = path ?? "";
  for (const [re, label] of PAGE_LABEL) if (re.test(p)) return label;
  if (title) return title.replace(/\s*[–|-]\s*Lone Peak Overland.*$/i, "").trim().slice(0, 60) || p;
  return p || "(page)";
}

function device(ua: string | null): string | null {
  if (!ua) return null;
  if (/iPhone|iPod/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return null;
}

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Los_Angeles" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

function sourceLabel(t: any): string | null {
  if (!t) return null;
  const src = (t.source ?? "").toLowerCase();
  if (t.fbclid || /^(facebook|fb|meta|instagram|ig)$/.test(src)) return `Meta ad${t.campaign ? ` · ${t.campaign}` : ""}`;
  if (t.gclid || t.gbraid || t.wbraid || src === "google") return `Google ad${t.campaign && !/^\d+$/.test(t.campaign) ? ` · ${t.campaign}` : ""}`;
  if (src) return `${src}${t.medium ? ` / ${t.medium}` : ""}`;
  if (t.referrer) { try { return new URL(t.referrer).hostname.replace(/^www\./, ""); } catch { return t.referrer; } }
  return null;
}

export async function computeWebActivity(db: SupabaseClient, emails: string[], opts: { days?: number } = {}): Promise<WebActivity | null> {
  const list = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  if (!list.length) return null;
  const { data: links } = await db.from("web_visitor_links").select("visitor_id").in("email", list);
  const vids = Array.from(new Set((links ?? []).map((l: any) => l.visitor_id).filter(Boolean)));
  if (!vids.length) return null;

  const since = new Date(Date.now() - (opts.days ?? 180) * 86_400_000).toISOString();
  const [{ data: events }, { data: touches }, { data: visitors }] = await Promise.all([
    db.from("web_events").select("visitor_id, session_id, at, type, path, title, duration_s, scroll_pct, sections, name, detail, referrer").in("visitor_id", vids).gte("at", since).order("at").limit(5000),
    db.from("web_touches").select("visitor_id, at, source, medium, campaign, gclid, gbraid, wbraid, fbclid, referrer").in("visitor_id", vids).gte("at", since).order("at"),
    db.from("web_visitors").select("visitor_id, user_agent").in("visitor_id", vids),
  ]);
  if (!events?.length) return null;
  const uaByVid = new Map((visitors ?? []).map((v: any) => [v.visitor_id, v.user_agent as string | null]));

  // Fold events into sessions → pages. A page = pageview; its pageend(s) add dwell; interactions attach to the latest page.
  const sessions = new Map<string, WebSession & { vid: string }>();
  for (const e of events as any[]) {
    let s = sessions.get(e.session_id);
    if (!s) {
      s = { id: e.session_id, vid: e.visitor_id, startedAt: e.at, endedAt: e.at, durationS: 0, pages: [], source: null, device: device(uaByVid.get(e.visitor_id) ?? null) };
      sessions.set(e.session_id, s);
    }
    if (e.at > s.endedAt) s.endedAt = e.at;
    // pageview opens a page; pageend/interaction attach to the open page for
    // that path (events are time-ordered, so this is the most recent one).
    let page = s.pages[s.pages.length - 1];
    if (e.type === "pageview" || !page || (page.path !== (e.path ?? ""))) {
      page = { path: e.path ?? "", title: e.title ?? null, at: e.at, durationS: 0, scrollPct: null, sections: [], interactions: [] };
      s.pages.push(page);
    }
    if (e.type === "pageview" && !page.title && e.title) page.title = e.title;
    if (e.type === "pageend") {
      page.durationS += e.duration_s ?? 0;
      s.durationS += e.duration_s ?? 0;
      if (e.scroll_pct != null) page.scrollPct = Math.max(page.scrollPct ?? 0, e.scroll_pct);
      for (const sec of e.sections ?? []) if (!page.sections.includes(sec)) page.sections.push(sec);
    } else if (e.type === "interaction") {
      page.interactions.push({ at: e.at, name: e.name, detail: e.detail ?? null });
    }
  }

  // Attribute each session to the last ad touch within 30 min before it started (or during it).
  const touchList = (touches ?? []) as any[];
  for (const s of sessions.values()) {
    const start = Date.parse(s.startedAt), end = Date.parse(s.endedAt);
    const t = touchList.filter((x) => x.visitor_id === s.vid && Date.parse(x.at) >= start - 30 * 60_000 && Date.parse(x.at) <= end + 60_000).pop();
    const ref = (events as any[]).find((e) => e.session_id === s.id && e.type === "pageview" && e.referrer)?.referrer ?? null;
    s.source = sourceLabel(t) ?? (ref ? sourceLabel({ referrer: ref }) : "direct");
  }

  const ordered = Array.from(sessions.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const totalS = ordered.reduce((n, s) => n + s.durationS, 0);
  const pageAgg = new Map<string, { path: string; title: string | null; views: number; durationS: number }>();
  for (const s of ordered) for (const p of s.pages) {
    const a = pageAgg.get(p.path) ?? { path: p.path, title: p.title, views: 0, durationS: 0 };
    a.views++; a.durationS += p.durationS; if (!a.title && p.title) a.title = p.title;
    pageAgg.set(p.path, a);
  }
  const topPages = Array.from(pageAgg.values()).sort((a, b) => b.durationS - a.durationS || b.views - a.views).slice(0, 8);
  const lastSeenAt = ordered[0]?.endedAt ?? null;
  const firstSeenAt = ordered[ordered.length - 1]?.startedAt ?? null;
  const summary = `${ordered.length} visit${ordered.length === 1 ? "" : "s"} · ${fmtDur(totalS)} · last ${lastSeenAt ? fmtWhen(lastSeenAt) : "—"}`;

  // AI brief: recent sessions with what they looked at and did. Compact, no raw urls.
  const briefLines: string[] = [summary];
  for (const s of ordered.slice(0, 5)) {
    const pages = s.pages.filter((p) => p.durationS >= 5 || p.interactions.length).slice(0, 6).map((p) => {
      const bits = [pageLabel(p.path, p.title) + (p.durationS ? ` ${fmtDur(p.durationS)}` : "")];
      if (p.sections.length) bits.push(`saw: ${p.sections.slice(0, 5).join(", ")}`);
      const ix = p.interactions.filter((i) => i.name !== "link").slice(0, 4).map((i) => i.name === "video" ? `video ${i.detail}` : i.name === "expand" ? `opened "${i.detail}"` : i.name === "click" ? `clicked "${i.detail}"` : i.name === "form_submit" ? `submitted ${i.detail}` : i.name === "tel" ? "tapped phone number" : `${i.name} ${i.detail ?? ""}`.trim());
      if (ix.length) bits.push(ix.join("; "));
      return bits.join(" — ");
    });
    briefLines.push(`• ${fmtWhen(s.startedAt)}${s.source ? ` via ${s.source}` : ""}${s.device ? ` on ${s.device}` : ""} (${fmtDur(s.durationS)}): ${pages.join(" | ") || "brief visit"}`);
  }
  const notable: string[] = [];
  const fin = topPages.find((p) => pageLabel(p.path, p.title) === "Financing");
  if (fin) notable.push(`viewed Financing ${fin.views}×`);
  const builder = topPages.find((p) => pageLabel(p.path, p.title) === "3D builder");
  if (builder) notable.push(`opened the 3D builder ${builder.views}×`);
  if (ordered.length >= 3) notable.push(`returned ${ordered.length} times`);
  if (notable.length) briefLines.push(`Notable: ${notable.join(", ")}`);

  return {
    summary, visits: ordered.length, totalS, lastSeenAt, firstSeenAt, topPages,
    sessions: ordered.slice(0, 30).map(({ vid: _v, ...s }) => s),
    brief: briefLines.join("\n"),
  };
}
