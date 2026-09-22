"use client";

import { useEffect, useState } from "react";

interface Cfg { slot_minutes: number; days: number[]; start: string; end: string; min_notice_hours: number; horizon_days: number }
interface Rep { id: string; name: string; email: string; slug: string; enabled: boolean; hasPhone: boolean; url: string | null }
interface Recent { id: string; name: string; email: string | null; phone: string | null; startAt: string; via: string; status: string; dealId: string | null; createdAt: string; rep: string | null }

const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function BookingSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [base, setBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () =>
    fetch("/api/admin/booking-config")
      .then((r) => r.json())
      .then((d) => { if (!d.error) { setCfg(d.config); setReps(d.reps); setRecent(d.recent); setBase(d.base); } else setMsg(d.error); });
  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    const r = await fetch("/api/admin/booking-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: cfg, reps: reps.map((x) => ({ id: x.id, slug: x.slug, enabled: x.enabled })) }),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    setMsg(r.ok ? "Saved." : d.error ?? "Save failed.");
    if (r.ok) void load();
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  if (!cfg) return <div className="viewsub">{msg ?? "Loading…"}</div>;

  const field: React.CSSProperties = { width: 110 };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="panel-h">Links</div>
        <div className="viewsub" style={{ marginTop: 0 }}>Share these anywhere Calendly links used to go. Times are offered in Pacific; customers see their own zone.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <b style={{ minWidth: 160 }}>Round robin (any guide)</b>
            <code style={{ fontSize: 13 }}>{base}</code>
            <button className="btn ghost" style={{ padding: "2px 10px", fontSize: 12.5 }} onClick={() => copy(base)}>{copied === base ? "Copied ✓" : "Copy"}</button>
          </div>
          {reps.filter((r) => r.enabled && r.url).map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b style={{ minWidth: 160 }}>{r.name}</b>
              <code style={{ fontSize: 13 }}>{r.url}</code>
              <button className="btn ghost" style={{ padding: "2px 10px", fontSize: 12.5 }} onClick={() => copy(r.url!)}>{copied === r.url ? "Copied ✓" : "Copy"}</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="panel-h">Availability (Pacific time)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 12px" }}>
          {DAY_LABEL.map((d, i) => (
            <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13.5, cursor: "pointer" }}>
              <input type="checkbox" checked={cfg.days.includes(i)} onChange={(e) => setCfg({ ...cfg, days: e.target.checked ? [...cfg.days, i].sort() : cfg.days.filter((x) => x !== i) })} /> {d}
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field"><label>Start</label><input type="time" className="vmsel" style={field} value={cfg.start} onChange={(e) => setCfg({ ...cfg, start: e.target.value })} /></div>
          <div className="field"><label>End</label><input type="time" className="vmsel" style={field} value={cfg.end} onChange={(e) => setCfg({ ...cfg, end: e.target.value })} /></div>
          <div className="field"><label>Call length (min)</label><input type="number" min={15} max={120} step={5} className="vmsel" style={field} value={cfg.slot_minutes} onChange={(e) => setCfg({ ...cfg, slot_minutes: Number(e.target.value) })} /></div>
          <div className="field"><label>Min notice (hours)</label><input type="number" min={0} max={72} className="vmsel" style={field} value={cfg.min_notice_hours} onChange={(e) => setCfg({ ...cfg, min_notice_hours: Number(e.target.value) })} /></div>
          <div className="field"><label>Book up to (days ahead)</label><input type="number" min={1} max={90} className="vmsel" style={field} value={cfg.horizon_days} onChange={(e) => setCfg({ ...cfg, horizon_days: Number(e.target.value) })} /></div>
        </div>
        <div className="viewsub" style={{ fontSize: 12.5 }}>Slots already booked, or clashing with a guide's timed activities, are never offered. Applies to every guide.</div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="panel-h">Gravel Guides</div>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ fontSize: 12, color: "var(--text-3)", textAlign: "left" }}>
              <th style={{ padding: "6px 8px" }}>Bookable</th><th style={{ padding: "6px 8px" }}>Rep</th><th style={{ padding: "6px 8px" }}>Slug</th><th style={{ padding: "6px 8px" }}>Link</th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={r.enabled} onChange={(e) => setReps(reps.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} /></td>
                <td style={{ padding: "6px 8px" }}>{r.name}{!r.hasPhone && <span style={{ color: "var(--text-3)", fontSize: 12 }}> · no phone line</span>}</td>
                <td style={{ padding: "6px 8px" }}><input className="vmsel" style={{ width: 140 }} value={r.slug} placeholder="e.g. jesse" onChange={(e) => setReps(reps.map((x) => (x.id === r.id ? { ...x, slug: e.target.value } : x)))} /></td>
                <td style={{ padding: "6px 8px", fontSize: 13, color: "var(--text-2)" }}>{r.slug ? `${base}/${r.slug.trim().toLowerCase()}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="viewsub" style={{ fontSize: 12.5 }}>Round robin rotates through every bookable guide, in this order, skipping anyone already booked at that time.</div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 22 }}>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save booking settings"}</button>
        {msg && <span style={{ fontSize: 13, color: msg === "Saved." ? "var(--good)" : "var(--crit)" }}>{msg}</span>}
      </div>

      <div className="card">
        <div className="panel-h">Recent bookings</div>
        {recent.length === 0 && <div className="viewsub" style={{ marginTop: 0 }}>None yet.</div>}
        {recent.length > 0 && (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
            <thead>
              <tr style={{ fontSize: 12, color: "var(--text-3)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Customer</th><th style={{ padding: "6px 8px" }}>Call (PT)</th><th style={{ padding: "6px 8px" }}>Guide</th><th style={{ padding: "6px 8px" }}>Via</th><th style={{ padding: "6px 8px" }}>Status</th><th style={{ padding: "6px 8px" }}>Booked</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((b) => (
                <tr key={b.id} style={{ borderTop: "1px solid var(--border)", opacity: b.status === "cancelled" ? 0.55 : 1 }}>
                  <td style={{ padding: "6px 8px" }}>{b.dealId ? <a href={`/crm/deal/${b.dealId}`} style={{ color: "var(--accent)" }}>{b.name}</a> : b.name}<div style={{ fontSize: 12, color: "var(--text-3)" }}>{b.phone} · {b.email}</div></td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{pt(b.startAt)}</td>
                  <td style={{ padding: "6px 8px" }}>{b.rep ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{b.via === "round_robin" ? "round robin" : "direct"}</td>
                  <td style={{ padding: "6px 8px" }}>{b.status}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "var(--text-3)" }}>{pt(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
