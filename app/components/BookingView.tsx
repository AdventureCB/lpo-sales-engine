"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Public "Schedule with a Gravel Guide" page — three steps:
 *   1. Booking type (Gravel Guide call / confirm your order / showroom visit)
 *   2. Date & time (time zone auto-detected)
 *   3. Contact details → book
 * Self-contained — no app chrome.
 */
interface Props {
  repSlug: string | null; // null = round robin
  repFirst: string | null;
}

type Kind = "call" | "confirm" | "showroom";
const SHOWROOM_ADDRESS = "13 Pangborn Rd, East Wenatchee, WA 98802";
const KINDS: { id: Kind; emoji: string; label: string; blurb: string; noun: string }[] = [
  { id: "call", emoji: "📞", label: "Gravel Guide Call", blurb: "Talk through your build, options and questions with one of our guides.", noun: "call" },
  { id: "confirm", emoji: "✅", label: "Confirm Your Order", blurb: "Already placed a deposit? Book a time to finalize your build together.", noun: "order confirmation call" },
  { id: "showroom", emoji: "🏠", label: "Showroom Appointment", blurb: `See the campers in person at our shop in East Wenatchee, WA.`, noun: "showroom visit" },
];
const isKind = (k: unknown): k is Kind => k === "call" || k === "confirm" || k === "showroom";

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
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<Kind | null>(null);
  // ?embed=1 — framed inside the main website: no LPO header, tight padding,
  // and the frame's height / step changes are posted to the parent page.
  const [embed, setEmbed] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("embed") === "1") setEmbed(true);
  }, []);
  useEffect(() => {
    if (!embed || window.parent === window) return;
    const post = () => window.parent.postMessage({ type: "lpo-book:height", height: mainRef.current?.offsetHeight ?? document.body.scrollHeight }, "*");
    post();
    const ro = new ResizeObserver(post);
    if (mainRef.current) ro.observe(mainRef.current);
    return () => ro.disconnect();
  }, [embed]);
  useEffect(() => {
    if (embed && window.parent !== window) window.parent.postMessage({ type: "lpo-book:step", step }, "*");
  }, [embed, step]);
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
  // (and booking type) and cancels the old booking once the new one is confirmed.
  const [rebook, setRebook] = useState<{ token: string; oldStartAt: string } | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const pre = qs.get("kind"); // ?kind=showroom deep-links straight to step 2
    if (isKind(pre)) { setKind(pre); setStep(2); }
    const token = qs.get("rebook");
    if (!token) return;
    fetch(`/api/book/manage?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || d.status !== "booked") return;
        setRebook({ token, oldStartAt: d.startAt });
        setForm({ name: d.name ?? "", phone: d.phone ?? "", email: d.email ?? "", note: "" });
        if (d.tz) setTz(d.tz);
        setKind(isKind(d.kind) ? d.kind : "call");
        setStep(2);
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
    if (!slot || !kind) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep: repSlug ?? "rr", kind, ...form, tz, startAt: slot, rebook: rebook?.token ?? undefined }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setError(d.error ?? "Something went wrong.");
        if (r.status === 409) { setSlot(null); setStep(2); load(); }
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
  const meta = kind ? KINDS.find((k) => k.id === kind)! : null;

  if (done && meta) {
    return (
      <Shell repFirst={repFirst} kind={kind} embed={embed} mainRef={mainRef}>
        <div style={{ ...card, textAlign: "center", padding: 32, maxWidth: 640, margin: "0 auto" }}>
          <div style={{ fontSize: 44 }}>{kind === "showroom" ? "🏠" : "✅"}</div>
          <h2 style={{ margin: "10px 0 6px" }}>
            {rebook ? `Your ${meta.noun} with ${done.repFirst} has been moved` : kind === "showroom" ? `See you at the showroom, ${form.name.split(/\s+/)[0]}!` : `You're booked with ${done.repFirst}`}
          </h2>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{fmtLong(done.startAt, tz)}</div>
          {kind === "showroom" ? (
            <p style={{ color: "var(--text-2)", marginTop: 12 }}>
              Lone Peak Overland · {SHOWROOM_ADDRESS}<br />{done.repFirst} will be there to meet you. A confirmation is on its way to {form.email}.
            </p>
          ) : (
            <p style={{ color: "var(--text-2)", marginTop: 12 }}>
              {done.repFirst} will call you at {form.phone}. A confirmation is on its way to {form.email}.
            </p>
          )}
        </div>
      </Shell>
    );
  }

  const canSubmit = !!slot && !submitting && form.name.trim().length < 2 === false && form.email.includes("@") && form.phone.replace(/\D/g, "").length >= 10;

  return (
    <Shell repFirst={repFirst} kind={kind} embed={embed} mainRef={mainRef}>
      <div style={{ display: "grid", gap: 16, maxWidth: 920, margin: "0 auto" }}>
        <Stepper step={step} kind={meta?.label ?? null} slotLabel={slot ? fmtLong(slot, tz) : null} onGo={(s) => { if (s < step) setStep(s); }} />

        {rebook && (
          <div style={{ background: "var(--accent-soft, rgba(217,91,49,0.14))", border: "1px solid var(--accent)", borderRadius: 10, padding: "8px 12px", fontSize: 14 }}>
            📅 Rescheduling your {meta?.noun ?? "call"} from <b>{fmtLong(rebook.oldStartAt, tz)}</b> — pick a new time and we'll release the old one.
          </div>
        )}

        {/* ── Step 1: booking type ── */}
        {step === 1 && (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }} className="book-cols3">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => { setKind(k.id); setStep(2); }}
                style={{
                  ...card, textAlign: "left", cursor: "pointer", display: "grid", gap: 6, alignContent: "start",
                  borderColor: kind === k.id ? "var(--accent)" : "var(--border)", color: "var(--text-1)",
                }}
              >
                <div style={{ fontSize: 30 }}>{k.emoji}</div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>{k.label}</div>
                <div style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.4 }}>{k.blurb}</div>
                <div style={{ color: "var(--accent)", fontWeight: 650, fontSize: 14, marginTop: 4 }}>Choose →</div>
              </button>
            ))}
          </div>
        )}

        {/* ── Step 2: date & time ── */}
        {step === 2 && (
          <>
            <div style={{ ...card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-2)", fontSize: 14 }}>🌎 Times shown in</span>
              <select value={tz} onChange={(e) => { setTz(e.target.value); setDay(null); setSlot(null); }} style={{ ...input, width: "auto", maxWidth: "100%" }}>
                {tzOptions.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}
              </select>
              {kind === "showroom" && <span style={{ color: "var(--text-3)", fontSize: 13 }}>Our shop is in Pacific time.</span>}
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
                <div style={{ color: "var(--text-3)", fontSize: 12.5, marginTop: 10 }}>{slotMinutes}-minute {meta?.noun ?? "call"}</div>
              </div>
            </div>

            {error && <div style={{ color: "var(--crit, #e0574a)", fontSize: 14 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
              <button className="btn ghost" style={{ padding: "10px 18px" }} onClick={() => setStep(1)}>‹ Back</button>
              <button className="btn primary" style={{ padding: "12px 22px", fontSize: 16, flex: 1, minWidth: 220 }} disabled={!slot} onClick={() => { setError(null); setStep(3); }}>
                {slot ? `Continue with ${fmtTime(slot, tz)} →` : "Pick a time to continue"}
              </button>
            </div>
          </>
        )}

        {/* ── Step 3: contact details ── */}
        {step === 3 && slot && meta && (
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{meta.emoji} {meta.label} · {fmtLong(slot, tz)}</div>
            <div style={{ color: "var(--text-2)", fontSize: 14, marginBottom: 12 }}>
              {kind === "showroom" ? `We'll meet you at ${SHOWROOM_ADDRESS}. Tell us who's coming.` : "Tell us how to reach you and we'll lock it in."}
            </div>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }} className="book-cols">
              <input style={input} placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
              <input style={input} placeholder="Phone number" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" inputMode="tel" />
              <input style={{ ...input, gridColumn: "1 / -1" }} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" inputMode="email" />
              <textarea
                style={{ ...input, gridColumn: "1 / -1", minHeight: 70, resize: "vertical" }}
                placeholder={kind === "showroom" ? "Anything you'd like to see while you're here? (optional)" : kind === "confirm" ? "Order number or anything to prep for the call? (optional)" : "Anything you'd like us to know before the call? (optional)"}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </div>
            {error && <div style={{ color: "var(--crit, #e0574a)", marginTop: 10, fontSize: 14 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn ghost" style={{ padding: "10px 18px" }} onClick={() => setStep(2)} disabled={submitting}>‹ Back</button>
              <button className="btn primary" style={{ padding: "12px 22px", fontSize: 16, flex: 1, minWidth: 220 }} disabled={!canSubmit} onClick={submit}>
                {submitting ? "Booking…" : rebook ? `Move my ${meta.noun} to ${fmtTime(slot, tz)}` : `Book ${fmtTime(slot, tz)} ${meta.noun}`}
              </button>
            </div>
          </div>
        )}
      </div>
      <style>{`
        @media (max-width: 720px) { .book-cols { grid-template-columns: 1fr !important; } .book-cols3 { grid-template-columns: 1fr !important; } }
        @media (max-width: 560px) { .book-steps .step-lbl { display: none; } }
      `}</style>
    </Shell>
  );
}

function Stepper({ step, kind, slotLabel, onGo }: { step: 1 | 2 | 3; kind: string | null; slotLabel: string | null; onGo: (s: 1 | 2 | 3) => void }) {
  const items: { n: 1 | 2 | 3; label: string; value: string | null }[] = [
    { n: 1, label: "Booking type", value: kind },
    { n: 2, label: "Date & time", value: slotLabel },
    { n: 3, label: "Your details", value: null },
  ];
  return (
    <div className="book-steps" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {items.map((it, i) => {
        const doneStep = it.n < step;
        const active = it.n === step;
        return (
          <div key={it.n} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
            <button
              onClick={() => onGo(it.n)}
              disabled={!doneStep}
              style={{
                display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, padding: "4px 2px", cursor: doneStep ? "pointer" : "default",
                color: active ? "var(--text-1)" : doneStep ? "var(--text-2)" : "var(--text-3)", minWidth: 0, textAlign: "left",
              }}
            >
              <span style={{
                width: 26, height: 26, borderRadius: 13, display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, flexShrink: 0,
                background: active || doneStep ? "var(--accent)" : "var(--surface-2)", color: active || doneStep ? "#fff" : "var(--text-3)",
                border: "1px solid " + (active || doneStep ? "var(--accent)" : "var(--border)"),
              }}>{doneStep ? "✓" : it.n}</span>
              <span className="step-lbl" style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: active ? 700 : 600, display: "block" }}>{it.label}</span>
                {doneStep && it.value && <span style={{ fontSize: 12, color: "var(--text-3)", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>{it.value} · change</span>}
              </span>
            </button>
            {i < items.length - 1 && <div style={{ flex: 1, height: 1, background: "var(--border)", minWidth: 12 }} />}
          </div>
        );
      })}
    </div>
  );
}

function Shell({ repFirst, kind, embed, mainRef, children }: { repFirst: string | null; kind: Kind | null; embed: boolean; mainRef: React.MutableRefObject<HTMLElement | null>; children: React.ReactNode }) {
  const title = repFirst ? `Schedule with ${repFirst}` : "Schedule with a Gravel Guide";
  const sub =
    kind === "showroom"
      ? `Pick a time to come see the campers in person at our shop — ${SHOWROOM_ADDRESS}.`
      : kind === "confirm"
        ? `Pick a time and ${repFirst ?? "your Gravel Guide"} will call to finalize your build with you.`
        : repFirst
          ? `Pick a time and ${repFirst} will give you a call to talk through your build.`
          : "Pick what you'd like to book, then a time — one of our Gravel Guides will take it from there. No pressure, just answers.";
  return (
    <main ref={mainRef} className={embed ? "book-embed" : undefined} style={{ minHeight: embed ? 0 : "100vh", background: "var(--surface-0)", color: "var(--text-1)", padding: embed ? "8px 8px 16px" : "28px 16px 60px" }}>
      {/* Embedded + light: pure white, no header or intro copy — the website
          around the frame carries the branding. */}
      {embed && <style>{`html[data-theme="light"] body, html[data-theme="light"] .book-embed { background: #fff !important; }`}</style>}
      {!embed && (
        <div style={{ maxWidth: 920, margin: "0 auto 20px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 900, fontSize: 20 }}>▲</div>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-3)" }}>Lone Peak Overland</div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
          </div>
        </div>
      )}
      {!embed && <p style={{ maxWidth: 920, margin: "0 auto 18px", color: "var(--text-2)", fontSize: 15 }}>{sub}</p>}
      {children}
    </main>
  );
}
