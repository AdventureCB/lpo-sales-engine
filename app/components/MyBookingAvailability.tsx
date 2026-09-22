"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * A guide's own booking setup — hours (Pacific), days off, and the
 * confirmation emails they send (one per booking type) — layered over the
 * team defaults. Used on My Profile (own) and, with repId, inside the admin
 * Booking settings for any guide.
 */
interface Hours { days?: number[]; start?: string; end?: string; blocked?: string[] }
interface Tpl { subject: string; body: string }
type Kind = "call" | "confirm" | "showroom";
interface Data {
  rep: { id: string; name: string; enabled: boolean; slug: string | null; url: string | null };
  hours: Hours | null;
  team: { days: number[]; start: string; end: string; slot_minutes: number };
  kinds: { id: Kind; label: string; emoji: string }[];
  emails: Partial<Record<Kind, Tpl>>;
  teamEmails: Record<Kind, Tpl>;
  vars: string[];
}

const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtT = (t: string) => { const [h, m] = t.split(":").map(Number); const d = new Date(2000, 0, 1, h, m); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
const render = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k in vars ? vars[k] : m));

export function MyBookingAvailability({ repId, compact }: { repId?: string; compact?: boolean }) {
  const qs = repId ? `?repId=${encodeURIComponent(repId)}` : "";
  const [data, setData] = useState<Data | null>(null);
  const [custom, setCustom] = useState(false);
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [blocked, setBlocked] = useState<string[]>([]);
  const [newOff, setNewOff] = useState("");
  // Per-type drafts: a type with `own: false` uses the team default.
  const [drafts, setDrafts] = useState<Record<Kind, { own: boolean; subject: string; body: string }>>({
    call: { own: false, subject: "", body: "" }, confirm: { own: false, subject: "", body: "" }, showroom: { own: false, subject: "", body: "" },
  });
  const [tab, setTab] = useState<Kind>("call");
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/settings/booking-availability${qs}`)
      .then((r) => r.json())
      .then((d: Data & { error?: string }) => {
        if (d.error) { setMsg(d.error); return; }
        setData(d);
        const h = d.hours;
        setCustom(!!(h && (h.days || h.start || h.end)));
        setDays(h?.days ?? d.team.days);
        setStart(h?.start ?? d.team.start);
        setEnd(h?.end ?? d.team.end);
        setBlocked(h?.blocked ?? []);
        const next = {} as Record<Kind, { own: boolean; subject: string; body: string }>;
        for (const k of d.kinds) {
          const own = d.emails?.[k.id];
          next[k.id] = { own: !!own, subject: (own ?? d.teamEmails[k.id]).subject, body: (own ?? d.teamEmails[k.id]).body };
        }
        setDrafts(next);
      });
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const hours = custom || blocked.length ? { ...(custom ? { days, start, end } : {}), blocked } : null;
    const emails: Partial<Record<Kind, Tpl>> = {};
    for (const k of Object.keys(drafts) as Kind[]) if (drafts[k].own) emails[k] = { subject: drafts[k].subject, body: drafts[k].body };
    const r = await fetch(`/api/settings/booking-availability${qs}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hours, emails }) });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    setMsg(r.ok ? "Saved." : d.error ?? "Save failed.");
    if (r.ok) void load();
  };

  const cur = drafts[tab];
  const setCur = (patch: Partial<{ own: boolean; subject: string; body: string }>) => setDrafts({ ...drafts, [tab]: { ...cur, ...patch } });

  // Live preview with sample values.
  const preview = useMemo(() => {
    if (!data) return { subject: "", body: "" };
    const vars: Record<string, string> = {
      first_name: "Alex", name: "Alex Rivera", when: "Thursday, September 24 at 2:00 PM MDT", date: "Thursday, September 24",
      time: "2:00 PM MDT", phone: "(509) 555-0134", rep_first: data.rep.name.split(/\s+/)[0], rep_name: data.rep.name,
      address: "13 Pangborn Rd, East Wenatchee, WA 98802",
    };
    const t = cur.own ? cur : data.teamEmails[tab];
    return { subject: render(t.subject, vars), body: render(t.body, vars) };
  }, [data, cur, tab]);

  if (!data) return <div className="viewsub">{msg ?? "Loading…"}</div>;
  if (!data.rep.enabled) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="panel-h">📅 My booking availability</div>
        <div className="viewsub" style={{ marginTop: 0 }}>Online booking isn't turned on for {repId ? data.rep.name : "you"} yet — an admin can enable it under Settings → Booking.</div>
      </div>
    );
  }

  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const upcomingOff = blocked.filter((d) => d >= todayIso);
  const input: React.CSSProperties = { width: "100%" };
  const invalid = (Object.keys(drafts) as Kind[]).some((k) => drafts[k].own && (!drafts[k].subject.trim() || !drafts[k].body.trim()));

  return (
    <div className="card" style={{ marginBottom: 16, ...(compact ? { padding: 14 } : {}) }}>
      {!compact && (
        <>
          <div className="panel-h">📅 My booking availability</div>
          {data.rep.url && (
            <div className="viewsub" style={{ marginTop: 0 }}>
              Your link: <code style={{ fontSize: 13 }}>{data.rep.url}</code>
              <button className="btn ghost" style={{ padding: "1px 8px", fontSize: 12, marginLeft: 6 }} onClick={() => void navigator.clipboard?.writeText(data.rep.url!)}>Copy</button>
            </div>
          )}
        </>
      )}

      {/* ── Hours ── */}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", margin: "6px 0 10px" }}>
        <input type="checkbox" checked={custom} onChange={(e) => { setCustom(e.target.checked); if (!e.target.checked) { setDays(data.team.days); setStart(data.team.start); setEnd(data.team.end); } }} />
        Set my own hours
        <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>
          (team default: {data.team.days.map((d) => DAY_LABEL[d]).join(" ")} · {fmtT(data.team.start)}–{fmtT(data.team.end)} PT)
        </span>
      </label>
      {custom && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {DAY_LABEL.map((d, i) => (
              <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13.5, cursor: "pointer" }}>
                <input type="checkbox" checked={days.includes(i)} onChange={(e) => setDays(e.target.checked ? [...days, i].sort() : days.filter((x) => x !== i))} /> {d}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field"><label>From (PT)</label><input type="time" className="vmsel" style={{ width: 110 }} value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label>To (PT)</label><input type="time" className="vmsel" style={{ width: 110 }} value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
        </div>
      )}

      {/* ── Days off ── */}
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>Days off <span style={{ color: "var(--text-3)", fontWeight: 400 }}>— nothing will be offered on these dates</span></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input type="date" className="vmsel" min={todayIso} value={newOff} onChange={(e) => setNewOff(e.target.value)} style={{ width: 160 }} />
        <button className="btn ghost" style={{ padding: "4px 12px", fontSize: 13 }} disabled={!newOff || blocked.includes(newOff)} onClick={() => { setBlocked([...blocked, newOff].sort()); setNewOff(""); }}>+ Add day off</button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {upcomingOff.length === 0 && <span style={{ color: "var(--text-3)", fontSize: 13 }}>None scheduled.</span>}
        {upcomingOff.map((d) => (
          <span key={d} className="chip stage" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            {new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}
            <button onClick={() => setBlocked(blocked.filter((x) => x !== d))} style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0 }} aria-label={`Remove ${d}`}>✕</button>
          </span>
        ))}
      </div>

      {/* ── Confirmation emails (one per booking type) ── */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>✉️ My confirmation emails <span style={{ color: "var(--text-3)", fontWeight: 400 }}>— sent from your Gmail when someone books; one per booking type</span></div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {data.kinds.map((k) => (
            <button key={k.id} className={`btn ${tab === k.id ? "primary" : "ghost"}`} style={{ padding: "3px 12px", fontSize: 13 }} onClick={() => setTab(k.id)}>
              {k.emoji} {k.label}{drafts[k.id].own ? " ✎" : ""}
            </button>
          ))}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", margin: "2px 0 8px" }}>
          <input type="checkbox" checked={cur.own} onChange={(e) => (e.target.checked ? setCur({ own: true }) : setCur({ own: false, subject: data.teamEmails[tab].subject, body: data.teamEmails[tab].body }))} />
          Write my own <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>(otherwise the team default is used)</span>
        </label>
        <div style={{ display: "grid", gap: 8 }}>
          <input className="vmsel" style={input} value={cur.subject} disabled={!cur.own} onChange={(e) => setCur({ subject: e.target.value })} placeholder="Subject" />
          <textarea className="vmsel" style={{ ...input, minHeight: 170, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }} value={cur.body} disabled={!cur.own} onChange={(e) => setCur({ body: e.target.value })} />
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 6 }}>
          Placeholders: {data.vars.map((v) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
          <br />The reschedule/cancel link is added automatically at the bottom.
        </div>
        <button className="btn ghost" style={{ padding: "3px 10px", fontSize: 12.5, marginTop: 8 }} onClick={() => setShowPreview(!showPreview)}>{showPreview ? "Hide preview" : "Preview with sample details"}</button>
        {showPreview && (
          <div style={{ marginTop: 8, background: "var(--surface-2)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}>
            <div style={{ fontWeight: 650, marginBottom: 6 }}>{preview.subject}</div>
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{preview.body}</div>
            <div style={{ color: "var(--text-3)", marginTop: 8 }}>Need to reschedule or cancel? https://book.lonepeakoverland.com/manage/…</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn primary" style={{ padding: "6px 16px", fontSize: 13.5 }} disabled={saving || invalid} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        {msg && <span style={{ fontSize: 13, color: msg === "Saved." ? "var(--good)" : "var(--crit)" }}>{msg}</span>}
      </div>
      <div className="viewsub" style={{ fontSize: 12.5 }}>Slot length, minimum notice and how far out customers can book are set by an admin for the whole team. Existing bookings and your scheduled activities are always blocked automatically.</div>
    </div>
  );
}
