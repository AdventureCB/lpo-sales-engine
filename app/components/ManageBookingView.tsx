"use client";

import { useState } from "react";

interface Props {
  token: string;
  booking: { status: string; startAt: string; name: string; tz: string | null; rep: { first: string; slug: string } | null };
}

const fmtLong = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));

export function ManageBookingView({ token, booking }: Props) {
  const [status, setStatus] = useState(booking.status);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = booking.tz || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "America/Los_Angeles"; } })();
  const repFirst = booking.rep?.first ?? "your Gravel Guide";
  const past = Date.parse(booking.startAt) < Date.now();

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/book/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "cancel" }) });
      const d = await r.json();
      if (!r.ok || d.error) setError(d.error ?? "Something went wrong.");
      else setStatus("cancelled");
    } catch {
      setError("Something went wrong — please try again.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const card: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 14, padding: 24, maxWidth: 560, margin: "0 auto" };

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg, #14120f)", color: "var(--text-1)", padding: "28px 16px 60px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--accent)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 900, fontSize: 20 }}>▲</div>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-3)" }}>Lone Peak Overland</div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Your call with {repFirst}</h1>
        </div>
      </div>

      <div style={card}>
        {status === "cancelled" ? (
          <>
            <div style={{ fontSize: 17, fontWeight: 700 }}>This call is cancelled.</div>
            <p style={{ color: "var(--text-2)" }}>Changed your mind? You can pick a new time any time.</p>
            {booking.rep && (
              <a className="btn primary" href={`/book/${booking.rep.slug}`} style={{ display: "inline-block", padding: "10px 18px" }}>
                Book a new time with {repFirst}
              </a>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "var(--text-3)" }}>Hi {booking.name.split(/\s+/)[0]} — you're booked for</div>
            <div style={{ fontSize: 19, fontWeight: 700, margin: "6px 0 14px" }}>{fmtLong(booking.startAt, tz)}</div>
            {past ? (
              <p style={{ color: "var(--text-2)" }}>This call time has passed. Want another? {booking.rep && <a href={`/book/${booking.rep.slug}`} style={{ color: "var(--accent)" }}>Book a new time</a>}</p>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {booking.rep && (
                  <a className="btn primary" href={`/book/${booking.rep.slug}?rebook=${token}`} style={{ padding: "10px 18px" }}>
                    📅 Reschedule
                  </a>
                )}
                {!confirm ? (
                  <button className="btn ghost" style={{ padding: "10px 18px" }} onClick={() => setConfirm(true)} disabled={busy}>
                    Cancel this call
                  </button>
                ) : (
                  <button className="btn" style={{ padding: "10px 18px", background: "var(--crit, #e0574a)", color: "#fff" }} onClick={cancel} disabled={busy}>
                    {busy ? "Cancelling…" : "Yes, cancel it"}
                  </button>
                )}
              </div>
            )}
            {error && <div style={{ color: "var(--crit, #e0574a)", marginTop: 10, fontSize: 14 }}>{error}</div>}
            <p style={{ color: "var(--text-3)", fontSize: 12.5, marginTop: 16 }}>Rescheduling keeps you with {repFirst} and releases your current slot.</p>
          </>
        )}
      </div>
    </main>
  );
}
