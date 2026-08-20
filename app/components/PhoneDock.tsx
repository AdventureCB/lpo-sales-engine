"use client";

import { useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import {
  answerIncoming,
  endIncoming,
  ensurePhone,
  silenceRing,
  getPhoneState,
  isAuxWindow,
  phoneRequired,
  subscribePhone,
} from "./phoneClient";

/**
 * Mounted in the app shell on every page: keeps the softphone connected the
 * whole time the app is open. Ringing = centered modal (with CRM caller-ID);
 * answered = slim banner so the rep can keep working.
 */
export function PhoneDock() {
  const router = useRouter();
  const [, rerender] = useReducer((x) => x + 1, 0);
  // Aux windows never host the phone (state set in an effect to avoid a
  // hydration mismatch — the flag lives in sessionStorage).
  const [aux, setAux] = useState(false);
  const [callerInfo, setCallerInfo] = useState<{
    phone: string;
    name: string | null;
    crmDealId: string | null;
    dealTitle: string | null;
  } | null>(null);
  // Ringing starts as a centered modal; opening the deal collapses it to a
  // banner so the page stays usable.
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    setAux(isAuxWindow());
    const unsub = subscribePhone(rerender);
    // Connect when browser-calling is the chosen method OR this rep receives
    // inbound on a Telnyx number (inbound must ring regardless of preference).
    // Aux windows never connect (phoneRequired is false there).
    void phoneRequired().then((w) => {
      if (w) void ensurePhone().catch(() => {});
    });
    return unsub;
  }, []);

  const { incoming } = getPhoneState();

  // Resolve the caller against the CRM the moment a call rings.
  useEffect(() => {
    const from = incoming?.from;
    if (!from) {
      setCallerInfo(null);
      setMinimized(false);
      return;
    }
    setMinimized(false);
    if (callerInfo?.phone === from) return;
    setCallerInfo({ phone: from, name: null, crmDealId: null, dealTitle: null });
    fetch(`/api/crm/contact-by-phone?phone=${encodeURIComponent(from)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setCallerInfo({
          phone: from,
          name: d.contact?.name ?? null,
          crmDealId: d.deal?.crmDealId ?? null,
          dealTitle: d.deal?.title ?? null,
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.from]);

  const who = callerInfo?.name?.trim() || incoming?.from || "";

  if (aux) return null;

  return (
    <>
      <audio id="telnyx-audio" autoPlay />

      {incoming && !incoming.active && !minimized && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.55)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <div
            style={{
              background: "var(--surface-1)",
              border: "2px solid var(--accent)",
              borderRadius: 16,
              padding: "34px 40px",
              minWidth: 320,
              maxWidth: "90vw",
              textAlign: "center",
              boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ fontSize: 34, marginBottom: 10 }}>📳</div>
            <div style={{ fontSize: 13, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Incoming call
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{who}</div>
            {callerInfo?.name && (
              <div style={{ fontSize: 14, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
                {incoming.from}
              </div>
            )}
            {callerInfo?.crmDealId && (
              <button
                className="btn ghost"
                style={{ fontSize: 13.5, padding: "6px 14px", marginTop: 10 }}
                onClick={() => {
                  setMinimized(true);
                  router.push(`/crm/deal/${callerInfo.crmDealId}`);
                }}
              >
                📋 {callerInfo.dealTitle ?? "Open deal"}
              </button>
            )}
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 22 }}>
              <button className="btn primary" style={{ padding: "12px 28px", fontSize: 15 }} onClick={answerIncoming}>
                ✅ Answer
              </button>
              <button
                className="btn"
                style={{ padding: "12px 22px", fontSize: 15 }}
                title="Silence the ring and keep working — the caller keeps ringing into voicemail"
                onClick={() => {
                  silenceRing();
                  setMinimized(true);
                }}
              >
                🔕 Ignore
              </button>
              <button className="btn ghost" style={{ padding: "12px 22px", fontSize: 15 }} onClick={endIncoming}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {incoming && !incoming.active && minimized && (
        <div
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: "var(--surface-1)",
            border: "2px solid var(--accent)",
            borderRadius: 12,
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
            flexWrap: "wrap",
            maxWidth: "92vw",
          }}
        >
          <b style={{ fontSize: 14.5 }}>📳 Ringing · {who}</b>
          <button className="btn primary" style={{ padding: "7px 16px", fontSize: 14 }} onClick={answerIncoming}>
            ✅ Answer
          </button>
          <button className="btn ghost" style={{ padding: "7px 12px", fontSize: 14 }} onClick={endIncoming}>
            Decline
          </button>
        </div>
      )}

      {incoming?.active && (
        <div
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: "var(--surface-1)",
            border: "2px solid var(--ok, #0ca30c)",
            borderRadius: 12,
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
            flexWrap: "wrap",
            maxWidth: "92vw",
          }}
        >
          <b style={{ fontSize: 14.5 }}>🟢 On call · {who}</b>
          <span style={{ fontSize: 12.5, color: "var(--warn, #d9a234)" }} title="Recording disclosure is the rep's responsibility — say it on the call">
            📼 recorded — disclose
          </span>
          {callerInfo?.crmDealId && (
            <button
              className="btn ghost"
              style={{ fontSize: 13, padding: "5px 10px" }}
              onClick={() => router.push(`/crm/deal/${callerInfo.crmDealId}`)}
            >
              📋 deal
            </button>
          )}
          <button
            className="btn"
            style={{ background: "var(--crit)", color: "#fff", padding: "7px 14px", fontSize: 14 }}
            onClick={endIncoming}
          >
            ⏹ End call
          </button>
        </div>
      )}
    </>
  );
}
