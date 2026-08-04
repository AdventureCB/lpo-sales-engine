"use client";

import { useEffect, useReducer } from "react";
import {
  answerIncoming,
  endIncoming,
  ensurePhone,
  getPhoneState,
  phoneWanted,
  subscribePhone,
} from "./phoneClient";

/**
 * Mounted in the app shell on every page: keeps the softphone connected the
 * whole time the app is open, and shows the incoming-call banner wherever
 * the rep happens to be (CRM, hot list, anywhere).
 */
export function PhoneDock() {
  const [, rerender] = useReducer((x) => x + 1, 0);

  useEffect(() => {
    const unsub = subscribePhone(rerender);
    if (phoneWanted()) {
      void ensurePhone().catch(() => {});
    }
    return unsub;
  }, []);

  const { incoming } = getPhoneState();

  return (
    <>
      <audio id="telnyx-audio" autoPlay />
      {incoming && (
        <div
          style={{
            position: "fixed",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: "var(--surface-1)",
            border: `2px solid ${incoming.active ? "var(--ok, #0ca30c)" : "var(--accent)"}`,
            borderRadius: 12,
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
            flexWrap: "wrap",
            maxWidth: "92vw",
          }}
        >
          <b style={{ fontSize: 14 }}>
            {incoming.active ? "🟢 On inbound call" : "📳 Incoming call"} ·{" "}
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{incoming.from}</span>
          </b>
          {!incoming.active ? (
            <>
              <button className="btn primary" style={{ padding: "8px 16px", fontSize: 13.5 }} onClick={answerIncoming}>
                ✅ Answer
              </button>
              <button className="btn ghost" style={{ padding: "8px 14px", fontSize: 13.5 }} onClick={endIncoming}>
                Decline
              </button>
            </>
          ) : (
            <button
              className="btn"
              style={{ background: "var(--crit)", color: "#fff", padding: "8px 16px", fontSize: 13.5 }}
              onClick={endIncoming}
            >
              ⏹ End call
            </button>
          )}
        </div>
      )}
    </>
  );
}
