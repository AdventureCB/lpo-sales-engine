"use client";

import { useEffect, useState } from "react";

/**
 * Commissions (admin): per-rep rollups with avg talk-to-deposit /
 * talk-to-confirmation, conflict strip, and the journeys table with order
 * numbers and per-journey talk times.
 */

interface Journey {
  id: string;
  state: string;
  is_conflict: boolean;
  rep: string | null;
  codeRep: string | null;
  ownerRep: string | null;
  customer: string;
  email: string | null;
  deposit_started_at: string | null;
  confirmed_at: string | null;
  expires_at: string | null;
  eligible_total_cents: number;
  commission_amount_cents: number;
  orders: { number: string; classification: string | null; subtotal_cents: number | null }[];
  talkToDepositS: number;
  talkToConfirmS: number;
}

interface Summary {
  rep: string;
  confirmed: number;
  commissionCents: number;
  avgTalkToDepositS: number | null;
  avgTalkToConfirmS: number | null;
  depositSample: number;
  confirmSample: number;
}

const STATE_LABEL: Record<string, string> = {
  deposit_only: "Deposit in",
  confirmed: "Confirmed ✓",
  walk_in: "Walk-in ✓",
  paid: "Paid",
  clawed_back: "Clawed back",
  expired: "Expired",
};

const STATE_COLOR: Record<string, string> = {
  deposit_only: "var(--warn, #fab219)",
  confirmed: "var(--ok, #0ca30c)",
  walk_in: "var(--ok, #0ca30c)",
  paid: "var(--ok, #0ca30c)",
  clawed_back: "var(--crit)",
  expired: "var(--text-3)",
};

function fmtTalk(s: number | null): string {
  if (!s) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
}

export function CommissionsView() {
  const [data, setData] = useState<{ journeys: Journey[]; summary: Summary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("all");

  useEffect(() => {
    fetch("/api/commissions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="viewsub">Couldn’t load commissions: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const conflicts = data.journeys.filter((j) => j.is_conflict);
  const shown =
    stateFilter === "all"
      ? data.journeys
      : data.journeys.filter((j) => (stateFilter === "conflict" ? j.is_conflict : j.state === stateFilter));

  return (
    <>
      <h2 className="viewtitle">Commissions</h2>
      <div className="viewsub">
        $500 deposit opens a journey · $5k cumulative confirms it ($100 flat) · talk time from Quo conversations with the customer’s number
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        {data.summary.map((s) => (
          <div className="card" key={s.rep} style={{ minWidth: 260, flex: 1 }}>
            <b style={{ fontSize: 14 }}>{s.rep}</b>
            <div style={{ display: "flex", gap: 18, marginTop: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{s.confirmed}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>Confirmed</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>${Math.round(s.commissionCents / 100)}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>Commission</div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{fmtTalk(s.avgTalkToDepositS)}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                  Avg talk → deposit{s.depositSample ? ` (${s.depositSample})` : ""}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{fmtTalk(s.avgTalkToConfirmS)}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                  Avg talk → confirm{s.confirmSample ? ` (${s.confirmSample})` : ""}
                </div>
              </div>
            </div>
          </div>
        ))}
        {data.summary.length === 0 && (
          <div className="viewsub">No journeys yet — they appear as orders come in (or after backfill).</div>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="card" style={{ marginBottom: 18, borderColor: "var(--crit)" }}>
          <b style={{ fontSize: 13, color: "var(--crit)" }}>
            ⚠ {conflicts.length} attribution conflict{conflicts.length === 1 ? "" : "s"} — commission held
          </b>
          {conflicts.slice(0, 5).map((j) => (
            <div key={j.id} style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 4 }}>
              {j.customer}: code says <b>{j.codeRep?.split(" ")[0] ?? "?"}</b>, deal owner is{" "}
              <b>{j.ownerRep?.split(" ")[0] ?? "?"}</b>
            </div>
          ))}
        </div>
      )}

      <div className="range-toggle" style={{ marginBottom: 12 }}>
        {[
          ["all", "All"],
          ["deposit_only", "Deposits in"],
          ["confirmed", "Confirmed"],
          ["walk_in", "Walk-ins"],
          ["expired", "Expired"],
          ["conflict", "Conflicts"],
        ].map(([key, label]) => (
          <button key={key} className={stateFilter === key ? "active" : ""} onClick={() => setStateFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {shown.map((j) => (
        <div className="card" style={{ marginBottom: 10 }} key={j.id}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 14 }}>{j.customer}</b>
            <span style={{ fontSize: 12, fontWeight: 700, color: STATE_COLOR[j.state] ?? "var(--text-2)" }}>
              {STATE_LABEL[j.state] ?? j.state}
            </span>
            {j.is_conflict && <span style={{ fontSize: 12, color: "var(--crit)" }}>⚠ conflict</span>}
            <span style={{ fontSize: 12, color: "var(--text-3)", marginLeft: "auto" }}>
              {j.rep ? j.rep.split(" ")[0] : j.is_conflict ? "held" : "unattributed"}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>
              {j.orders.map((o) => `${o.number} (${o.classification ?? "?"})`).join(" · ") || "no orders linked"}
            </span>
            <span>${Math.round(j.eligible_total_cents / 100).toLocaleString()} eligible</span>
            <span>Deposit {fmtDate(j.deposit_started_at)}</span>
            {j.confirmed_at && <span>Confirmed {fmtDate(j.confirmed_at)}</span>}
            {j.state === "deposit_only" && <span>Expires {fmtDate(j.expires_at)}</span>}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>
              🗣 <b>{fmtTalk(j.talkToDepositS)}</b> <span style={{ color: "var(--text-3)" }}>talk → deposit</span>
            </span>
            {(j.state === "confirmed" || j.state === "walk_in" || j.state === "paid") && (
              <span>
                🗣 <b>{fmtTalk(j.talkToConfirmS)}</b> <span style={{ color: "var(--text-3)" }}>talk → confirmation</span>
              </span>
            )}
          </div>
        </div>
      ))}
      {shown.length === 0 && <div className="viewsub">Nothing in this bucket.</div>}
    </>
  );
}
