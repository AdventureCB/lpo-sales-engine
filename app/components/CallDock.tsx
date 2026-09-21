"use client";

import { useEffect, useReducer, useState } from "react";
import { usePathname } from "next/navigation";
import { getPhoneState, subscribePhone, endOutbound, toggleOutboundMute } from "./phoneClient";

/**
 * Global outbound-call controls, bottom-right on EVERY page (Kyle 9/16:
 * calls from deal pages / Demo Finder showed no controls — the old panel was
 * trapped inside the deal-page CommBar). Driven by the softphone's global
 * outbound state, so any newOutboundCall gets a timer / mute / end. Hidden on
 * the dialer, which has its own call controls.
 */
function mmss(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CallDock() {
  const pathname = usePathname();
  const [, rerender] = useReducer((x) => x + 1, 0);
  const [, tick] = useReducer((x) => x + 1, 0);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => subscribePhone(rerender), []);
  const { outbound } = getPhoneState();

  // 1s timer while a call is up.
  useEffect(() => {
    if (!outbound) return;
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [outbound]);

  // Resolve the number to a CRM name once per call.
  useEffect(() => {
    const num = outbound?.number;
    if (!num) {
      setName(null);
      return;
    }
    fetch(`/api/crm/contact-by-phone?phone=${encodeURIComponent(num)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setName(d?.contact?.name ?? null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbound?.number]);

  // The dialer has its own controls; don't double up.
  if (!outbound || (pathname ?? "").startsWith("/dialer")) return null;

  const sec = outbound.startedAt ? (Date.now() - outbound.startedAt) / 1000 : 0;

  return (
    <div
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 8600,
        width: "min(360px, 92vw)",
        boxShadow: "0 10px 34px rgba(0,0,0,0.4)",
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
      className="card"
    >
      <span style={{ fontSize: 20 }}>📞</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 750, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name?.trim() || outbound.number}
        </div>
        <div style={{ fontSize: 12.5, color: outbound.state === "active" ? "var(--good)" : "var(--text-3)" }}>
          {outbound.state === "active"
            ? `On call · ${mmss(sec)}`
            : outbound.state === "ending"
              ? `Ending in ${Math.max(1, Math.ceil(((outbound.endsAt ?? Date.now()) - Date.now()) / 1000))}s · short-call minimum`
              : outbound.state === "ringing"
                ? "Ringing…"
                : "Connecting…"}
        </div>
      </div>
      {outbound.state === "active" && (
        <button
          className="btn ghost"
          style={{ padding: "6px 10px", fontSize: 13 }}
          onClick={toggleOutboundMute}
          title={outbound.muted ? "Unmute" : "Mute"}
        >
          {outbound.muted ? "🔇" : "🎤"}
        </button>
      )}
      {outbound.state !== "ending" && (
        <button
          className="btn"
          style={{ padding: "6px 14px", fontSize: 13.5, background: "var(--crit)", color: "#fff" }}
          onClick={endOutbound}
        >
          ⏹ End
        </button>
      )}
    </div>
  );
}
