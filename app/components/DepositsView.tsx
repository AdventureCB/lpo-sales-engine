"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Open Deposits — deposits that haven't confirmed yet. Age since deposit,
 * escalating color, and whether the confirmation follow-up is actually on
 * the calendar (red when it isn't — those are the ones bleeding).
 */

interface DepositRow {
  dealId: string;
  title: string;
  personName: string | null;
  valueCents: number | null;
  ownerPipedriveId: number | null;
  stageName: string;
  depositAt: string | null;
  daysSitting: number | null;
  nextActivity: { subject: string | null; type: string; dueAt: string } | null;
  overdueActivity: boolean;
}

const OWNER_NAMES: Record<number, string> = { 24081760: "Parker", 24391245: "Jackson", 24723797: "Cainen", 23851101: "Gabi" };

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }) : "—";
const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function ageColor(days: number | null): string {
  if (days == null) return "var(--text-3)";
  if (days >= 14) return "var(--crit)";
  if (days >= 7) return "var(--warn)";
  return "var(--good)";
}

export function DepositsView() {
  const [all, setAll] = useState<DepositRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repFilter, setRepFilter] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/deposits")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setAll(d.deposits))
      .catch((e) => setError(String(e)));
  }, []);

  // Rep filter chips — owners actually present, biggest book first.
  const owners = [...new Set((all ?? []).map((r) => r.ownerPipedriveId).filter(Boolean))] as number[];
  const rows = all ? (repFilter != null ? all.filter((r) => r.ownerPipedriveId === repFilter) : all) : null;

  const missing = (rows ?? []).filter((r) => !r.nextActivity);
  const overdue = (rows ?? []).filter((r) => r.overdueActivity);
  const totalValue = (rows ?? []).reduce((a, r) => a + (r.valueCents ?? 0), 0);
  const avgDays = rows && rows.length ? Math.round(rows.reduce((a, r) => a + (r.daysSitting ?? 0), 0) / rows.length) : 0;

  return (
    <div>
      <div className="viewhead"><h1>💵 Open Deposits</h1></div>
      <p className="viewsub">
        Deposits waiting on confirmation. Every one should have a confirmation follow-up scheduled — red rows don't.
      </p>

      {all && owners.length > 0 && (
        <div className="range-toggle" style={{ marginBottom: 14 }}>
          <button className={repFilter == null ? "active" : ""} onClick={() => setRepFilter(null)}>All</button>
          {owners.map((o) => (
            <button key={o} className={repFilter === o ? "active" : ""} onClick={() => setRepFilter(o)}>
              {OWNER_NAMES[o] ?? o}
            </button>
          ))}
        </div>
      )}

      {rows && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
          <div className="stat-tile"><div className="n">{rows.length}</div><div className="l">Open deposits</div></div>
          <div className="stat-tile"><div className="n">${Math.round(totalValue / 100).toLocaleString()}</div><div className="l">Pipeline value</div></div>
          <div className="stat-tile"><div className="n">{avgDays}d</div><div className="l">Avg sitting</div></div>
          <div className="stat-tile"><div className="n" style={{ color: missing.length ? "var(--crit)" : "var(--good)" }}>{missing.length}</div><div className="l">No follow-up</div></div>
          <div className="stat-tile"><div className="n" style={{ color: overdue.length ? "var(--warn)" : "var(--good)" }}>{overdue.length}</div><div className="l">Overdue follow-up</div></div>
        </div>
      )}

      {error && <p className="viewsub" style={{ color: "var(--crit)" }}>{error}</p>}
      {!rows && !error && <p className="viewsub">Loading…</p>}

      {rows && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-3)", fontSize: 12 }}>
                {["Deal", "Rep", "Value", "Stage", "Deposit", "Sitting", "Confirmation follow-up"].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-soft)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.dealId} style={{ borderBottom: "1px solid var(--border-soft)", background: !r.nextActivity ? "rgba(224,72,72,0.07)" : undefined }}>
                  <td style={{ padding: "9px 14px" }}>
                    <Link href={`/crm/deal/${r.dealId}`} style={{ color: "var(--text-1)", fontWeight: 600 }}>
                      {r.personName ?? r.title}
                    </Link>
                  </td>
                  <td style={{ padding: "9px 14px" }}>{r.ownerPipedriveId ? OWNER_NAMES[r.ownerPipedriveId] ?? r.ownerPipedriveId : "—"}</td>
                  <td style={{ padding: "9px 14px", fontVariantNumeric: "tabular-nums" }}>
                    {r.valueCents != null ? `$${Math.round(r.valueCents / 100).toLocaleString()}` : "—"}
                  </td>
                  <td style={{ padding: "9px 14px", whiteSpace: "nowrap", color: "var(--text-2)" }}>{r.stageName}</td>
                  <td style={{ padding: "9px 14px", whiteSpace: "nowrap", color: "var(--text-3)" }}>{fmtDate(r.depositAt)}</td>
                  <td style={{ padding: "9px 14px", fontWeight: 750, color: ageColor(r.daysSitting), fontVariantNumeric: "tabular-nums" }}>
                    {r.daysSitting != null ? `${r.daysSitting}d` : "—"}
                  </td>
                  <td style={{ padding: "9px 14px", whiteSpace: "nowrap" }}>
                    {r.nextActivity ? (
                      <span style={{ color: r.overdueActivity ? "var(--warn)" : "var(--text-2)" }}>
                        {r.overdueActivity ? "⚠ overdue — " : ""}
                        {r.nextActivity.subject ?? r.nextActivity.type} · {fmtWhen(r.nextActivity.dueAt)}
                      </span>
                    ) : (
                      <Link href={`/crm/deal/${r.dealId}`} style={{ color: "var(--crit)", fontWeight: 650 }}>
                        ✗ none — schedule now
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 16, color: "var(--text-3)" }}>No open deposits. 🎉</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
