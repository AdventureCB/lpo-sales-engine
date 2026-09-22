"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Public "Schedule with a Gravel Guide" page. Customer picks a time zone
 * (auto-detected), a day, a slot, enters name / phone / email, done.
 * Self-contained — no app chrome.
 */
interface Props {
  repSlug: string | null; // null = round robin
  repFirst: string | null;
}

const COMMON_TZ = [
  "America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York",
  "America/Anchorage", "Pacific/Honolulu", "America/Vancouver", "America/Edmonton", "America/Toronto",
];

function tzLabel(tz: string, at = Date.now()): string {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value;
    return `${tz.replace(/_/g, " ").replace("America/", "")} (${abbr})`;
  } catch {
    return tz;
  }
}
const dayKey = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const fmtTime = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fmtLong = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));

export function BookingView({ repSlug, repFirst }: Props) {
  const [tz, setTz] = useState<string>(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles"; } catch { return "America/Los_Angeles"; }
  });
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ startAt: string; repFirst: string } | null>(null);
  // Reschedule flow: /book/<slug>?rebook=<token> prefills the customer's details
  // and cancels the old booking once the new one is confirmed.
  const [rebook, setRebook] = useState<{ token: string; oldStartAt: string } | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("rebook");
    if (!token) return;
    fetch(`/api/book/manage?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || d.status !== "booked") return;
        setRebook({ token, oldStartAt: d.startAt });
        setForm({ name: d.name ?? "", phone: d.phone ?? "", email: d.email ?? "", note: "" });
        if (d.tz) setTz(d.tz);
      })
      .catch(() => {});
  }, []);

  const load = () => {
    setSlots(null);
    fetch(`/api/book/slots?rep=${encodeURIComponent(repSlug ?? "rr")}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); else { setSlots(d.slots); setSlotMinutes(d.slotMinutes ?? 30); } })
      .catch(() => setError("Couldn't load availability. Please refresh."));
  };
  useEffect(load, [repSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots ?? []) (m.get(dayKey(s, tz)) ?? m.set(dayKey(s, tz), []).get(dayKey(s, tz))!).push(s);
    return m;
  }, [slots, tz]);

  // First available day auto-selected.
  useEffect(() => {
    if (!day && byDay.size) {
      const first = [...byDay.keys()].sort()[0];
      setDay(first);
      const [y, mo] = first.split("-").map(Number);
      setMonth({ y, m: mo - 1 });
    }
  }, [byDay, day]);

  const tzOptions = useMemo(() => {
    const set = new Set<string>([tz, ...COMMON_TZ]);
    try { for (const z of (Intl as any).supportedValuesOf?.("timeZone") ?? []) set.add(z); } catch {}
    return [...set];
  }, [tz]);

  const submit = async () => {
    if (!slot) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep: repSlug ?? "rr", ...form, tz, startAt: slot, rebook: rebook?.token ?? undefined }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setError(d.error ?? "Something went wrong.");
        if (r.status === 409) { setSlot(null); load(); }
      } else {
        setDone({ startAt: d.startAt, repFirst: d.rep?.first ?? repFirst ?? "your Gravel Guide" });
      }
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Month grid ──
  const grid = useMemo(() => {
    const first = new Date(month.y, month.m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const days = new Date(month.y, month.m + 1, 0).getDate();
    const cells: (string | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= days; d++) cells.push(`${month.y}-${String(month.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [month]);
  const monthLabel = new Date(month.y, month.m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const card: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 14, padding: 20 };
  const input: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-1)", fontSize: 15 };

  if (done) {
    return (
      <Shell repFirst={repFirst}>
        <div style={{ ...card, textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 44 }}>✅</div>
          <h2 style={{ margin: "10px 0 6px" }}>{rebook ? `Your call with ${done.repFirst} has been moved` : `You're booked with ${done.repFirst}`}</h2>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{fmtLong(done.startAt, tz)}</div>
          <p style={{ color: "var(--text-2)", marginTop: 12 }}>
            {done.repFirst} will call you at {form.phone}. A confirmation is on its way to {form.email}.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell repFirst={repFirst}>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr", maxWidth: 920, margin: "0 auto" }}>
        <div style={{ ...card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-2)", fontSize: 14 }}>🌎 Times shown in</span>
          <select value={tz} onChange={(e) => { setTz(e.target.value); setDay(null); setSlot(null); }} style={{ ...input, width: "auto", maxWidth: "100%" }}>
            {tzOptions.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}
          </select>
        </div>

        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }} className="book-cols">
          {/* Calendar */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <button className="btn ghost" onClick={() => setMonth((m) => ({ y: m.m === 0 ? m.y - 1 : m.y, m: (m.m + 11) % 12 }))} aria-label="Previous month">‹</button>
              <b>{monthLabel}</b>
              <button className="btn ghost" onClick={() => setMonth((m) => ({ y: m.m === 11 ? m.y + 1 : m.y, m: (m.m + 1) % 12 }))} aria-label="Next month">›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, fontSize: 12, color: "var(--text-3)", textAlign: "center", marginBottom: 4 }}>
              {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <div key={d}>{d}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
              {grid.map((d, i) => {
                const has = d ? byDay.has(d) : false;
                const sel = d === day;
                return (
                  <button
                    key={i}
                    disabled={!has}
                    onClick={() => { setDay(d); setSlot(null); }}
                    style={{
                      aspectRatio: "1", borderRadius: 9, border: "1px solid " + (sel ? "var(--accent)" : "transparent"),
                      background: sel ? "var(--accent)" : has ? "var(--accent-soft, rgba(217,91,49,0.14))" : "transparent",
                      color: sel ? "#fff" : has ? "var(--text-1)" : "var(--text-3)", fontWeight: has ? 650 : 400,
                      cursor: has ? "pointer" : "default", opacity: d ? 1 : 0,
                    }}
                  >
                    {d ? Number(d.slice(-2)) : ""}
                  </button>
                );
              })}
            </div>
            {slots === null && !error && <div style={{ color: "var(--text-3)", fontSize: 13, marginTop: 10 }}>Loading availability…</div>}
            {slots !== null && slots.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 13, marginTop: 10 }}>No open times right now — please check back soon.</div>}
          </div>

          {/* Slots */}
          <div style={card}>
            <b>{day ? new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "Pick a day"}</b>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", marginTop: 12, maxHeight: 340, overflowY: "auto" }}>
              {(day ? byDay.get(day) ?? [] : []).map((s) => (
                <button
                  key={s}
                  onClick={() => setSlot(s)}
                  style={{
                    padding: "10px 8px", borderRadius: 9, fontSize: 14.5, fontWeight: 600, cursor: "pointer",
                    border: "1px solid " + (slot === s ? "var(--accent)" : "var(--border)"),
                    background: slot === s ? "var(--accent)" : "var(--surface-2)", color: slot === s ? "#fff" : "var(--text-1)",
                  }}
                >
                  {fmtTime(s, tz)}
                </button>
              ))}
            </div>
            <div style={{ color: "var(--text-3)", fontSize: 12.5, marginTop: 10 }}>{slotMinutes}-minute call</div>
          </div>
        </div>

        {/* Details */}
        <div style={card}>
          {rebook && (
            <div style={{ background: "var(--accent-soft, rgba(217,91,49,0.14))", border: "1px solid var(--accent)", borderRadius: 10, padding: "8px 12px", marginBottom: 12, fontSize: 14 }}>
              📅 Rescheduling your call from <b>{fmtLong(rebook.oldStartAt, tz)}</b> — pick a new time above and we'll release the old one.
            </div>
          )}
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{slot ? `Your call: ${fmtLong(slot, tz)}` : "Choose a time above, then tell us how to reach you"}</div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", marginTop: 12 }} className="book-cols">
            <input style={input} placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
            <input style={input} placeholder="Phone number" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" inputMode="tel" />
            <input style={{ ...input, gridColumn: "1 / -1" }} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" inputMode="email" />
            <textarea style={{ ...input, gridColumn: "1 / -1", minHeight: 70, resize: "vertical" }} placeholder="Anything you'd like us to know before the call? (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          {error && <div style={{ color: "var(--crit, #e0574a)", marginTop: 10, fontSize: 14 }}>{error}</div>}
          <button
            className="btn primary"
            style={{ marginTop: 14, padding: "12px 22px", fontSize: 16, width: "100%" }}
            disabled={!slot || submitting || form.name.trim().length < 2 || !form.email.includes("@") || form.phone.replace(/\D/g, "").length < 10}
            onClick={submit}
          >
            {submitting ? "Booking…" : slot ? `Book ${fmtTime(slot, tz)} call` : "Pick a time to continue"}
          </button>
        </div>
      </div>
      <style>{`@media (max-width: 720px) { .book-cols { grid-template-columns: 1fr !important; } }`}</style>
    </Shell>
  );
}

function Shell({ repFirst, children }: { repFirst: string | null; children: React.ReactNode }) {
  return (
    <main style={{ minHeight: "100vh", background: "var(--bg, #14120f)", color: "var(--text-1)", padding: "28px 16px 60px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 900, fontSize: 20 }}>▲</div>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-3)" }}>Lone Peak Overland</div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{repFirst ? `Schedule a call with ${repFirst}` : "Schedule with a Gravel Guide"}</h1>
        </div>
      </div>
      <p style={{ maxWidth: 920, margin: "0 auto 18px", color: "var(--text-2)", fontSize: 15 }}>
        {repFirst
          ? `Pick a time and ${repFirst} will give you a call to talk through your build.`
          : "Pick a time and one of our Gravel Guides will give you a call to talk through your build — no pressure, just answers."}
      </p>
      {children}
    </main>
  );
}
