"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface CallEntry {
  id: string;
  at: string;
  direction: "incoming" | "outgoing" | null;
  status: string | null;
  missed: boolean;
  durationS: number | null;
  rep: string | null;
  peer: string | null;
  contactName: string | null;
  crmDealId: string | null;
  dealTitle: string | null;
  disposition: string | null;
  classification: string | null;
  quality: { avg_loss_pct?: number; max_jitter_ms?: number } | null;
  hasTranscript: boolean;
}

type Filter = "all" | "missed" | "incoming" | "outgoing";

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function fmtDur(s: number | null) {
  if (s == null) return "—";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const DISPO_LABEL: Record<string, string> = {
  connected: "✅ Connected",
  vm_dropped: "🎙 VM left",
  no_answer: "📵 No answer",
  bad_number: "🚫 Bad number",
  callback: "📅 Callback",
  confirmation: "📋 Confirmation call",
};

export function CallLogView() {
  const router = useRouter();
  const [calls, setCalls] = useState<CallEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      const qs = filter === "missed" ? "?missed=1" : "";
      fetch(`/api/phone/calls${qs}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => live && setCalls(d.calls))
        .catch((e) => live && setError(String(e)));
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [filter]);

  const shown = (calls ?? []).filter((c) => {
    if (filter === "incoming") return c.direction === "incoming";
    if (filter === "outgoing") return c.direction === "outgoing";
    return true; // "all" and "missed" (missed is server-filtered)
  });
  const missedCount = (calls ?? []).filter((c) => c.missed).length;

  if (error) return <div className="viewsub">Couldn’t load the call log: {error}</div>;

  return (
    <>
      <h2 className="viewtitle">Call log</h2>
      <div className="viewsub">
        Every call across the team — both directions, all lines.
        {filter === "all" && missedCount > 0 && (
          <b style={{ color: "var(--crit)" }}> · {missedCount} missed recently</b>
        )}
      </div>

      <div className="range-toggle">
        {(
          [
            ["all", "All"],
            ["missed", "📵 Missed"],
            ["incoming", "↙ Inbound"],
            ["outgoing", "↗ Outbound"],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {calls === null && <div className="viewsub" style={{ padding: 16 }}>Loading…</div>}
        {calls !== null && shown.length === 0 && (
          <div className="viewsub" style={{ padding: 16, marginBottom: 0 }}>No calls match.</div>
        )}
        {shown.map((c, i) => (
          <div
            key={c.id}
            onClick={() => c.crmDealId && router.push(`/crm/deal/${c.crmDealId}`)}
            style={{
              display: "grid",
              gridTemplateColumns: "34px 1.4fr 1fr 90px 1fr 130px",
              gap: 10,
              alignItems: "center",
              padding: "11px 16px",
              borderBottom: i < shown.length - 1 ? "1px solid var(--border-soft)" : "none",
              cursor: c.crmDealId ? "pointer" : "default",
              fontSize: 14.5,
            }}
            title={c.crmDealId ? `Open deal: ${c.dealTitle}` : undefined}
          >
            <span style={{ fontSize: 16 }}>
              {c.missed ? "📵" : c.direction === "incoming" ? "↙️" : "↗️"}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <b style={{ color: c.missed ? "var(--crit)" : "var(--text-1)" }}>
                {c.contactName ?? c.peer ?? "Unknown"}
              </b>
              {c.contactName && c.peer && (
                <span style={{ color: "var(--text-3)", marginLeft: 8, fontSize: 13 }}>{c.peer}</span>
              )}
            </span>
            <span style={{ color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.rep ?? "—"}
            </span>
            <span style={{ color: "var(--text-2)", fontVariantNumeric: "tabular-nums" }}>
              {c.missed ? "missed" : fmtDur(c.durationS)}
            </span>
            <span style={{ color: "var(--text-3)", fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.disposition
                ? DISPO_LABEL[c.disposition] ?? c.disposition
                : c.classification ?? c.status ?? ""}
              {c.hasTranscript && " · 📝"}
              {c.quality?.avg_loss_pct != null && ` · 📶 ${c.quality.avg_loss_pct}%`}
            </span>
            <span style={{ color: "var(--text-3)", fontSize: 13.5, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {fmtWhen(c.at)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
