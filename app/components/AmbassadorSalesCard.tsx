"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Ambassador sales on the Revenue page: monthly history split by how the
 * order was tied to an ambassador (roster code vs Shopify Collabs referral),
 * per-ambassador totals for the page's window, and roster upkeep — codes
 * seen on orders that belong to nobody yet can be assigned with one click.
 */

interface MonthRow { month: string; orders: number; netCents: number; discountCents: number; code: number; collabs: number; unmapped: number }
interface AmbRow { id: string | null; name: string; orders: number; netCents: number; discountCents: number; customers: number; viaCode: number; viaCollabs: number }
interface Roster { id: string; name: string; codes: string[]; refIds: string[]; active: boolean; notes: string | null }
interface Cand { code: string; orders: number; netCents: number; firstAt: string; lastAt: string; collabsOrders: number }
interface Payload { months: MonthRow[]; ambassadors: AmbRow[]; roster: Roster[]; candidates: Cand[]; collabsOrders: number }

const usd = (c: number | null | undefined, compact = false) => {
  if (c == null) return "—";
  const v = c / 100;
  if (compact && Math.abs(v) >= 100000) return `$${(v / 1000).toFixed(0)}k`;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
};
const monthLabel = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
const COLOR_CODE = "var(--accent)";
const COLOR_COLLABS = "#7aa7d9";
const COLOR_UNMAPPED = "var(--surface-3)";

export function AmbassadorSalesCard({ from, to, periodLabel }: { from: string; to: string; periodLabel: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [showCands, setShowCands] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCodes, setNewCodes] = useState("");
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/revenue/ambassadors?from=${from}&to=${to}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const post = async (body: any, key: string) => {
    setBusy(key);
    try {
      const r = await fetch("/api/admin/revenue/ambassadors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const months = (data?.months ?? []).slice(-24);
  const totalInWindow = (data?.ambassadors ?? []).reduce((s, a) => s + a.netCents, 0);
  const ordersInWindow = (data?.ambassadors ?? []).reduce((s, a) => s + a.orders, 0);
  const inputStyle: React.CSSProperties = { background: "var(--surface-2)", color: "var(--text-1)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", fontSize: 12.5 };
  const td: React.CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div className="card" style={{ marginTop: 14, padding: "14px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 750 }}>Ambassador sales</div>
        <div style={{ fontSize: 12, color: "var(--text-3)", display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: COLOR_CODE, borderRadius: 2, marginRight: 5 }} />Ambassador code</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: COLOR_COLLABS, borderRadius: 2, marginRight: 5 }} />Collabs referral link</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: COLOR_UNMAPPED, border: "1px solid var(--border)", borderRadius: 2, marginRight: 5 }} />Collabs, no ambassador mapped</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-3)", margin: "4px 0 8px" }}>
        An order is an ambassador sale when it used a code on the roster, or Shopify Collabs stamped it with a referral id. Net revenue per order, all products. Older sales came through Collabs; recent ones mostly through standard codes, so keep the roster current.
      </div>
      {error && <div style={{ color: "var(--crit)", fontSize: 12.5, marginBottom: 6 }}>{error}</div>}
      {!data && !error && <div style={{ color: "var(--text-3)", fontSize: 13 }}>Loading…</div>}

      {data && (
        <>
          <Bars months={months} />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontWeight: 650, fontSize: 13 }}>By ambassador, {periodLabel}</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>{ordersInWindow} orders · {usd(totalInWindow)} net</div>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto", marginTop: 6 }}>
            <table className="data-table" style={{ fontSize: 13, width: "100%" }}>
              <thead><tr><th>Ambassador</th><th style={td}>Orders</th><th style={td}>Customers</th><th style={td}>Net revenue</th><th style={td}>Discount given</th><th style={td}>Via code</th><th style={td}>Via Collabs</th></tr></thead>
              <tbody>
                {data.ambassadors.map((a) => (
                  <tr key={a.id ?? "unmapped"}>
                    <td style={{ fontWeight: a.id ? 650 : 500, color: a.id ? "var(--text-1)" : "var(--text-3)" }}>{a.name}</td>
                    <td style={td}>{a.orders}</td>
                    <td style={td}>{a.customers}</td>
                    <td style={{ ...td, fontWeight: 650 }}>{usd(a.netCents)}</td>
                    <td style={{ ...td, color: "var(--text-3)" }}>{usd(a.discountCents)}</td>
                    <td style={{ ...td, color: "var(--text-3)" }}>{a.viaCode}</td>
                    <td style={{ ...td, color: "var(--text-3)" }}>{a.viaCollabs}</td>
                  </tr>
                ))}
                {data.ambassadors.length === 0 && <tr><td colSpan={7} style={{ color: "var(--text-3)" }}>No ambassador sales in this window{data.roster.length === 0 ? " — the roster is empty, start with the unassigned codes below" : ""}.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setShowCands((v) => !v)}>
              Unassigned codes ({data.candidates.length}) {showCands ? "▴" : "▾"}
            </button>
            <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setShowRoster((v) => !v)}>
              Roster ({data.roster.length}) {showRoster ? "▴" : "▾"}
            </button>
            <span style={{ fontSize: 12, color: "var(--text-3)", alignSelf: "center" }}>{data.collabsOrders.toLocaleString()} orders carry a Collabs referral id</span>
          </div>

          {showCands && (
            <div style={{ marginTop: 10, borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>
                Discount codes used on 2+ orders in the last two years that aren&apos;t rep codes, Loox, deposits or system labels. Assign the ambassador ones; ignore the rest (promos like FREEGRAB or 20%OFFGEAR).
              </div>
              <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
                <table className="data-table" style={{ fontSize: 12.5, width: "100%" }}>
                  <thead><tr><th>Code</th><th style={td}>Orders</th><th style={td}>Net</th><th>First → last</th><th>Assign to</th></tr></thead>
                  <tbody>
                    {data.candidates.map((c) => (
                      <tr key={c.code}>
                        <td style={{ fontFamily: "ui-monospace, monospace" }}>{c.code}</td>
                        <td style={td}>{c.orders}</td>
                        <td style={td}>{usd(c.netCents)}</td>
                        <td style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>{c.firstAt.slice(0, 10)} → {c.lastAt.slice(0, 10)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <select value={assignTo[c.code] ?? ""} onChange={(e) => setAssignTo((s) => ({ ...s, [c.code]: e.target.value }))} style={inputStyle}>
                            <option value="">— pick —</option>
                            <option value="__new__">New ambassador named “{c.code}”</option>
                            {data.roster.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                          <button
                            className="btn ghost"
                            style={{ padding: "3px 9px", fontSize: 12, marginLeft: 6 }}
                            disabled={!assignTo[c.code] || busy === c.code}
                            onClick={() => post(assignTo[c.code] === "__new__" ? { action: "assign", code: c.code, name: c.code } : { action: "assign", code: c.code, ambassadorId: assignTo[c.code] }, c.code)}
                          >
                            {busy === c.code ? "…" : "Assign"}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {data.candidates.length === 0 && <tr><td colSpan={5} style={{ color: "var(--text-3)" }}>Nothing unassigned.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {showRoster && (
            <div style={{ marginTop: 10, borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <input placeholder="Ambassador name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ ...inputStyle, width: 200 }} />
                <input placeholder="Codes, comma separated" value={newCodes} onChange={(e) => setNewCodes(e.target.value)} style={{ ...inputStyle, width: 320 }} />
                <button className="btn primary" style={{ padding: "4px 12px", fontSize: 12.5 }} disabled={!newName.trim() || busy === "new"} onClick={async () => { await post({ action: "upsert", name: newName, codes: newCodes.split(",") }, "new"); setNewName(""); setNewCodes(""); }}>Add</button>
              </div>
              <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto" }}>
                <table className="data-table" style={{ fontSize: 12.5, width: "100%" }}>
                  <thead><tr><th>Name</th><th>Codes</th><th>Collabs ref ids</th><th>Active</th><th></th></tr></thead>
                  <tbody>
                    {data.roster.map((r) => <RosterRow key={r.id} r={r} busy={busy === r.id} onSave={(patch) => post({ action: "upsert", ...r, ...patch }, r.id)} onDelete={() => { if (confirm(`Remove ${r.name} from the roster?`)) post({ action: "delete", id: r.id }, r.id); }} />)}
                    {data.roster.length === 0 && <tr><td colSpan={5} style={{ color: "var(--text-3)" }}>Roster is empty.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RosterRow({ r, busy, onSave, onDelete }: { r: Roster; busy: boolean; onSave: (patch: Partial<Roster>) => void; onDelete: () => void }) {
  const [codes, setCodes] = useState(r.codes.join(", "));
  const [refs, setRefs] = useState(r.refIds.join(", "));
  const [name, setName] = useState(r.name);
  useEffect(() => { setCodes(r.codes.join(", ")); setRefs(r.refIds.join(", ")); setName(r.name); }, [r]);
  const dirty = name !== r.name || codes !== r.codes.join(", ") || refs !== r.refIds.join(", ");
  const inputStyle: React.CSSProperties = { background: "var(--surface-2)", color: "var(--text-1)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 7px", fontSize: 12.5, width: "100%" };
  return (
    <tr style={{ opacity: r.active ? 1 : 0.55 }}>
      <td style={{ minWidth: 160 }}><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></td>
      <td style={{ minWidth: 260 }}><input value={codes} onChange={(e) => setCodes(e.target.value)} style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }} /></td>
      <td style={{ minWidth: 160 }}><input value={refs} onChange={(e) => setRefs(e.target.value)} placeholder="optional" style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }} /></td>
      <td><input type="checkbox" checked={r.active} onChange={(e) => onSave({ active: e.target.checked })} /></td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button className="btn ghost" style={{ padding: "3px 9px", fontSize: 12 }} disabled={!dirty || busy} onClick={() => onSave({ name, codes: codes.split(","), refIds: refs.split(",") } as any)}>{busy ? "…" : "Save"}</button>
        <button className="btn ghost" style={{ padding: "3px 9px", fontSize: 12, marginLeft: 4, color: "var(--crit)" }} onClick={onDelete}>✕</button>
      </td>
    </tr>
  );
}

function Bars({ months }: { months: MonthRow[] }) {
  if (months.length === 0) return <div style={{ color: "var(--text-3)", fontSize: 13, padding: "16px 0" }}>No ambassador sales recorded yet.</div>;
  const W = 900, H = 220, padL = 56, padR = 8, padT = 12, padB = 26;
  const n = months.length;
  const max = Math.max(1, ...months.map((m) => m.netCents));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const group = innerW / n;
  const bw = Math.max(6, Math.min(40, group - 8));
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }} role="img" aria-label="Ambassador sales per month">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" />
            <text x={padL - 6} y={y(t) + 4} fontSize={10} fill="var(--text-3)" textAnchor="end">{usd(t, true)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const x0 = padL + i * group + (group - bw) / 2;
          const segs = [
            { v: m.code, c: COLOR_CODE, l: "ambassador code" },
            { v: m.collabs, c: COLOR_COLLABS, l: "Collabs referral" },
            { v: m.unmapped, c: COLOR_UNMAPPED, l: "Collabs, unmapped" },
          ];
          let acc = 0;
          return (
            <g key={m.month}>
              {segs.map((s) => {
                const y1 = y(acc + s.v), h = Math.max(0, y(acc) - y1);
                acc += s.v;
                return <rect key={s.l} x={x0} y={y1} width={bw} height={h} fill={s.c} stroke={s.c === COLOR_UNMAPPED ? "var(--border)" : "none"}><title>{`${monthLabel(m.month)} ${s.l}: ${usd(s.v)}`}</title></rect>;
              })}
              <title>{`${monthLabel(m.month)}: ${usd(m.netCents)} · ${m.orders} orders · ${usd(m.discountCents)} discounts`}</title>
              {(n <= 14 || i % 2 === 0) && <text x={x0 + bw / 2} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle">{monthLabel(m.month)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
