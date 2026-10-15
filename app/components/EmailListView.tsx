"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface Item {
  dealId: string; title: string; personName: string | null; email: string; source: string | null; stage: string | null; pipeline: string | null;
  createdAt: string; lastActivityAt: string | null; lastSignalAt: string | null; lastHotAt: string | null; lastEmailAt: string | null; lastEmailBy: string | null; campaign: string | null; attempts: number;
}

const rel = (iso: string | null) => {
  if (!iso) return "—";
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};

export function EmailListView({ isAdmin, userEmail }: { isAdmin: boolean; userEmail: string }) {
  const [rep, setRep] = useState(userEmail);
  const [reps, setReps] = useState<{ email: string; name: string }[]>([]);
  const [pool, setPool] = useState(false);
  const [data, setData] = useState<{ items: Item[]; repName: string | null } | null>(null);
  const [filter, setFilter] = useState<"all" | "untouched7" | "never">("untouched7");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaigns, setCampaigns] = useState<{ id: string; name: string; channel: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setData(null);
    fetch(`/api/crm/email-list?${pool ? "pool=1" : `rep=${encodeURIComponent(rep)}`}`).then((r) => r.json()).then((d) => !d.error && setData(d)).catch(() => {});
  }, [rep, pool]);
  useEffect(() => { load(); setSelected(new Set()); }, [load]);
  useEffect(() => {
    if (isAdmin) fetch("/api/admin/users").then((r) => r.ok ? r.json() : null).then((d) => d && setReps((d.users ?? []).filter((u: any) => u.email && u.pipedriveUserId && u.repActive !== false).map((u: any) => ({ email: u.email, name: u.name ?? u.email })))).catch(() => {});
    fetch("/api/campaigns").then((r) => r.ok ? r.json() : null).then((d) => d && setCampaigns((d.campaigns ?? []).filter((c: any) => c.status === "active" && c.channel === "email").map((c: any) => ({ id: c.id, name: c.name, channel: c.channel })))).catch(() => {});
  }, [isAdmin]);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    const week = Date.now() - 7 * 86_400_000;
    const needle = q.trim().toLowerCase();
    return all.filter((it) => {
      if (filter === "never" && it.lastEmailAt) return false;
      if (filter === "untouched7" && it.lastEmailAt && Date.parse(it.lastEmailAt) > week) return false;
      if (needle && !`${it.title} ${it.personName ?? ""} ${it.email} ${it.source ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, filter, q]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  async function snooze(days: number) {
    if (!selected.size) return;
    const r = await fetch("/api/crm/email-list", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "snooze", dealIds: [...selected], days }) });
    setMsg(r.ok ? `✓ Snoozed ${selected.size} for ${days} days` : "⚠ Snooze failed");
    setSelected(new Set()); load();
  }
  async function enroll(campaignId: string) {
    if (!selected.size || !campaignId) return;
    const r = await fetch("/api/campaigns/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaignId, dealIds: [...selected] }) });
    const j = await r.json().catch(() => ({}));
    const ok = (j.results ?? []).filter((x: any) => x.ok).length;
    setMsg(r.ok ? `✓ Enrolled ${ok} of ${selected.size}` : `⚠ ${j.error ?? "enroll failed"}`);
    setSelected(new Set()); load();
  }

  const th: React.CSSProperties = { padding: "6px 8px", fontSize: 12, color: "var(--text-3)", textAlign: "left", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "7px 8px", fontSize: 13, borderTop: "1px solid var(--border-soft)", verticalAlign: "top" };
  const todayCount = (data?.items ?? []).filter((it) => it.lastEmailAt && rel(it.lastEmailAt) === "today").length;

  return (
    <>
      <h2 style={{ margin: "0 0 4px" }}>📧 Email list</h2>
      <p className="viewsub" style={{ marginTop: 0 }}>
        Open deals with an email but no usable phone, so they never reach the dialer or sprint lists. Ranked like a sprint list: freshest buy signal first. Emails you send from the deal page count automatically.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "10px 0 12px" }}>
        {isAdmin && !pool && (
          <select className="vmsel" value={rep} onChange={(e) => setRep(e.target.value)}>
            {!reps.some((r) => r.email === rep) && <option value={rep}>{rep}</option>}
            {reps.map((r) => <option key={r.email} value={r.email}>{r.name}</option>)}
          </select>
        )}
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={pool} onChange={(e) => setPool(e.target.checked)} /> unassigned pool</label>
        <span style={{ width: 1, height: 20, background: "var(--border)" }} />
        {([["untouched7", "Not emailed in 7 days"], ["never", "Never emailed"], ["all", "All"]] as const).map(([k, l]) => (
          <button key={k} className={`btn ${filter === k ? "primary" : "ghost"}`} style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => setFilter(k)}>{l}</button>
        ))}
        <input className="vmsel" placeholder="search name / email / source" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--text-2)" }}>
          {data ? `${items.length} of ${data.items.length}` : "…"}{todayCount ? ` · ✉️ ${todayCount} emailed today` : ""}
        </span>
      </div>

      {selected.size > 0 && (
        <div className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 12px", marginBottom: 10 }}>
          <b style={{ fontSize: 13 }}>{selected.size} selected</b>
          <select className="vmsel" defaultValue="" onChange={(e) => { void enroll(e.target.value); e.target.value = ""; }} title="Enroll in an email drip campaign">
            <option value="">📣 Enroll in campaign…</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="vmsel" defaultValue="" onChange={(e) => { void snooze(Number(e.target.value)); e.target.value = ""; }}>
            <option value="">💤 Snooze…</option>
            <option value={7}>1 week</option><option value={14}>2 weeks</option><option value={30}>30 days</option><option value={90}>90 days</option>
          </select>
          <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setSelected(new Set())}>Clear</button>
          {msg && <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{msg}</span>}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 28 }}><input type="checkbox" checked={items.length > 0 && items.every((i) => selected.has(i.dealId))} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.dealId)) : new Set())} /></th>
              <th style={th}>Deal</th><th style={th}>Email</th><th style={th}>Source · stage</th>
              <th style={th} title="Most recent marketing signal (email click, site visit, saved build…)">Last signal</th>
              <th style={th}>Last emailed</th><th style={th}>Campaign</th><th style={th}>Created</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={9} style={{ ...td, color: "var(--text-3)" }}>Loading…</td></tr>}
            {data && items.length === 0 && <tr><td colSpan={9} style={{ ...td, color: "var(--text-3)" }}>Nothing here{filter !== "all" ? " for this filter" : ""}.</td></tr>}
            {items.map((it) => {
              const hot = it.lastHotAt && Date.now() - Date.parse(it.lastHotAt) < 14 * 86_400_000;
              return (
                <tr key={it.dealId} style={{ background: selected.has(it.dealId) ? "var(--surface-2)" : undefined }}>
                  <td style={td}><input type="checkbox" checked={selected.has(it.dealId)} onChange={() => toggle(it.dealId)} /></td>
                  <td style={td}>
                    <Link href={`/crm/deal/${it.dealId}`} style={{ fontWeight: 600 }}>{it.title}</Link>
                    {it.personName && it.personName !== it.title && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{it.personName}</div>}
                  </td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>{it.email}</td>
                  <td style={{ ...td, color: "var(--text-2)", fontSize: 12.5 }}>{it.source ?? "—"}<div style={{ color: "var(--text-3)" }}>{it.stage ?? "—"}</div></td>
                  <td style={{ ...td, fontWeight: hot ? 700 : 400, color: hot ? "var(--good)" : "var(--text-2)" }} title={it.lastHotAt ? `Hot signal ${rel(it.lastHotAt)}` : undefined}>{hot ? "🔥 " : ""}{rel(it.lastSignalAt)}</td>
                  <td style={{ ...td, color: it.lastEmailAt ? "var(--text-2)" : "var(--warn)" }} title={it.lastEmailBy ?? undefined}>{it.lastEmailAt ? rel(it.lastEmailAt) : "never"}</td>
                  <td style={{ ...td, fontSize: 12.5, color: "var(--text-2)" }}>{it.campaign ? `📣 ${it.campaign}` : ""}</td>
                  <td style={{ ...td, color: "var(--text-3)", fontSize: 12.5 }}>{rel(it.createdAt)}</td>
                  <td style={td}><Link href={`/crm/deal/${it.dealId}`} className="btn ghost" style={{ padding: "3px 10px", fontSize: 12.5, whiteSpace: "nowrap" }}>✉️ Open &amp; email</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
