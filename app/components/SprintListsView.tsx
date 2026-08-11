"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type ListRow = {
  id: string;
  name: string;
  owner: string;
  kind: string;
  slot: number | null;
  forDate: string | null;
  cap: number | null;
  status: string;
  total: number;
  called: number;
  removed: number;
};

type ItemRow = {
  dealId: string;
  pipedriveDealId: number | null;
  title: string;
  personName: string | null;
  phone: string | null;
  stageName: string;
  valueCents: number | null;
  tier: number | null;
  tierLabel: string | null;
  source: string | null;
  tzBucket: string | null;
  flag: string | null;
  pipelineName?: string;
  stageName?: string;
  dealStatus?: string;
  calledAt: string | null;
  removedAt: string | null;
  addedManually: boolean;
  disposition: string | null;
};

const REPS = [
  { email: "parker@lonepeakoverland.com", name: "Parker" },
  { email: "jackson@lonepeakoverland.com", name: "Jackson" },
];

const TIER_BADGE: Record<string, { label: string; color: string }> = {
  "1a": { label: "🔥 Buy intent", color: "#e8623a" },
  "1b": { label: "✦ Engaged", color: "#d99a2b" },
  "2": { label: "📅 Scheduled today", color: "#3aa0e8" },
  "3": { label: "🆕 New", color: "#4ab86a" },
  "4": { label: "📣 Marketing", color: "#9a7be0" },
  "5": { label: "❄ No convo 60d", color: "#7c8aa0" },
  "6": { label: "❄ Dormant", color: "#7c8aa0" },
  stale: { label: "🕸 Stale 60–90d", color: "#8a7c6a" },
  reprospect: { label: "♻ Reprospect", color: "#c05a9a" },
  carry: { label: "↩ Carryover", color: "#6a9ab8" },
  manual: { label: "＋ Manual", color: "#6a8a6a" },
};

function badge(label: string | null) {
  const b = TIER_BADGE[label ?? ""] ?? { label: label ?? "—", color: "#7c8aa0" };
  return (
    <span style={{ background: b.color + "22", color: b.color, border: `1px solid ${b.color}55`, borderRadius: 6, padding: "1px 7px", fontSize: 12, whiteSpace: "nowrap" }}>
      {b.label}
    </span>
  );
}

export function SprintListsView({ isAdmin, userEmail }: { isAdmin: boolean; userEmail: string }) {
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [genRep, setGenRep] = useState(isAdmin ? REPS[0].email : userEmail);

  const [openId, setOpenId] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  const [addQ, setAddQ] = useState("");
  const [addResults, setAddResults] = useState<{ id: string; title: string }[]>([]);

  const loadLists = useCallback(async () => {
    setLoading(true);
    const r = await fetch("/api/crm/sprint-lists");
    const j = await r.json();
    setLists(j.lists ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const openList = useCallback(async (id: string) => {
    setOpenId(id);
    setItemsLoading(true);
    setAddQ("");
    setAddResults([]);
    const r = await fetch(`/api/crm/sprint-lists?sprintId=${id}`);
    const j = await r.json();
    setItems(j.items ?? []);
    setItemsLoading(false);
  }, []);

  async function generate(slot: number) {
    setBusy(`gen${slot}`);
    setMsg(null);
    const r = await fetch("/api/crm/sprint-lists/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, ...(isAdmin ? { repEmail: genRep } : {}) }),
    });
    const j = await r.json();
    setBusy(null);
    if (!r.ok) {
      setMsg(`⚠ ${j.error ?? "generation failed"}`);
      return;
    }
    setMsg(`✓ List ${slot} generated — ${j.count} deals${isAdmin ? ` for ${genRep.split("@")[0]}` : ""}`);
    await loadLists();
    if (openId) await openList(openId);
  }

  async function itemOp(op: string, dealId?: string) {
    if (!openId) return;
    await fetch("/api/crm/sprint-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, sprintId: openId, dealId }),
    });
    if (op === "archive") {
      setOpenId(null);
      await loadLists();
      return;
    }
    await openList(openId);
    await loadLists();
  }

  const searchAdd = useCallback(async (q: string) => {
    if (!q.trim()) {
      setAddResults([]);
      return;
    }
    const r = await fetch(`/api/crm/deals?q=${encodeURIComponent(q)}&status=open`);
    const j = await r.json();
    setAddResults((j.deals ?? []).slice(0, 8).map((d: any) => ({ id: d.id, title: d.title })));
  }, []);

  const openList_ = lists.find((l) => l.id === openId);

  // ── Organization: today's dailies front-and-center; archives + custom
  //    lists in folders; admins pick a rep first. ──
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const owners = [...new Set(lists.map((l) => l.owner))].sort();
  const [repTab, setRepTab] = useState<string | null>(null);
  const activeOwner = isAdmin ? (repTab ?? owners[0] ?? userEmail) : userEmail;
  const mine = lists.filter((l) => l.owner === activeOwner);
  const todayLists = mine.filter((l) => l.kind === "daily" && l.forDate === today).sort((a, b) => (a.slot ?? 9) - (b.slot ?? 9));
  const customLists = mine.filter((l) => l.kind !== "daily");
  const archiveLists = mine
    .filter((l) => l.kind === "daily" && l.forDate !== null && l.forDate < today)
    .sort((a, b) => (b.forDate ?? "").localeCompare(a.forDate ?? ""));
  const [showArchive, setShowArchive] = useState(false);
  const [showCustom, setShowCustom] = useState(true);

  const listCard = (l: ListRow, sub?: string) => (
    <button
      key={l.id}
      className="card"
      onClick={() => openList(l.id)}
      style={{ padding: "12px 14px", textAlign: "left", cursor: "pointer", border: openId === l.id ? "1.5px solid var(--accent)" : undefined }}
    >
      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>
        {l.kind === "daily" ? "📋" : l.kind === "assigned" ? "📨" : "⚡"} {l.name}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", display: "flex", gap: 10 }}>
        <span><b style={{ color: "var(--text-1)" }}>{l.total - l.called}</b> to call</span>
        <span>{l.called} done</span>
        {l.removed > 0 && <span>{l.removed} removed</span>}
        {sub && <span style={{ marginLeft: "auto" }}>{sub}</span>}
      </div>
    </button>
  );

  return (
    <div>
      <div className="viewhead">
        <h1>📋 Sprint Lists</h1>
      </div>
      <p className="viewsub">
        Daily one-click call lists that plug straight into the dialer. Lists 1 &amp; 2 are your morning calls
        by timezone; List 3 (auto at 1&nbsp;PM) is follow-ups + the reprospecting pool.
      </p>

      {/* Generate */}
      <div className="card" style={{ padding: "14px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 14.5 }}>Generate</b>
        {isAdmin && (
          <select className="vmsel" style={{ width: "auto" }} value={genRep} onChange={(e) => setGenRep(e.target.value)}>
            {REPS.map((r) => (
              <option key={r.email} value={r.email}>{r.name}</option>
            ))}
          </select>
        )}
        <button className="btn primary" disabled={busy === "gen1"} onClick={() => generate(1)}>
          {busy === "gen1" ? "…" : "List 1 · East+Central"}
        </button>
        <button className="btn primary" disabled={busy === "gen2"} onClick={() => generate(2)}>
          {busy === "gen2" ? "…" : "List 2 · West"}
        </button>
        {isAdmin && (
          <button className="btn ghost" disabled={busy === "gen3"} onClick={() => generate(3)} title="Normally auto-generates at 1 PM">
            {busy === "gen3" ? "…" : "List 3 · Follow-up + Reprospect"}
          </button>
        )}
      </div>
      {msg && <div className="viewsub" style={{ color: msg.startsWith("✓") ? "var(--good)" : "var(--bad)" }}>{msg}</div>}

      {loading ? (
        <p className="viewsub">Loading…</p>
      ) : (
        <>
          {/* Admin: pick the rep first */}
          {isAdmin && owners.length > 0 && (
            <div className="range-toggle" style={{ marginBottom: 14 }}>
              {owners.map((o) => (
                <button key={o} className={activeOwner === o ? "active" : ""} onClick={() => { setRepTab(o); setOpenId(null); }}>
                  {o.split("@")[0].replace(/^./, (c) => c.toUpperCase())}
                </button>
              ))}
            </div>
          )}

          {/* Today's lists */}
          <div className="panel-h" style={{ marginBottom: 8 }}>Today</div>
          {todayLists.length === 0 ? (
            <p className="viewsub">No lists generated today{activeOwner === userEmail ? " — hit a Generate button above" : ""}.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
              {todayLists.map((l) => listCard(l))}
            </div>
          )}

          {/* Custom lists folder */}
          <button className="btn ghost" style={{ display: "block", marginBottom: 8, padding: "6px 12px", fontSize: 13.5 }} onClick={() => setShowCustom(!showCustom)}>
            {showCustom ? "▾" : "▸"} ⚡ Custom lists ({customLists.length})
          </button>
          {showCustom && customLists.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
              {customLists.map((l) => listCard(l, l.kind === "assigned" ? "assigned" : undefined))}
            </div>
          )}

          {/* Archive folder: previous days, newest first */}
          <button className="btn ghost" style={{ display: "block", marginBottom: 8, padding: "6px 12px", fontSize: 13.5 }} onClick={() => setShowArchive(!showArchive)}>
            {showArchive ? "▾" : "▸"} 🗂 Archive ({archiveLists.length})
          </button>
          {showArchive && archiveLists.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
              {archiveLists.map((l) =>
                listCard(l, new Date(`${l.forDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }))
              )}
            </div>
          )}
        </>
      )}

      {/* Preview / edit */}
      {openId && openList_ && (
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 15 }}>{openList_.name}</b>
            <Link href="/dialer" className="btn ghost" style={{ padding: "5px 10px", fontSize: 13 }}>▶ Open in Dialer</Link>
            <button className="btn ghost" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => itemOp("archive")}>Archive</button>
            <button className="btn ghost" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => setOpenId(null)}>Close</button>
          </div>

          {/* Manual add */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10, position: "relative", flexWrap: "wrap" }}>
            <input
              className="vmsel"
              style={{ width: 280 }}
              placeholder="🔍 Add a deal by name…"
              value={addQ}
              onChange={(e) => { setAddQ(e.target.value); void searchAdd(e.target.value); }}
            />
            {addResults.length > 0 && (
              <div className="card" style={{ position: "absolute", top: 38, left: 0, zIndex: 5, minWidth: 280, padding: 4 }}>
                {addResults.map((d) => (
                  <button
                    key={d.id}
                    className="btn ghost"
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", fontSize: 13 }}
                    onClick={async () => { await itemOp("add", d.id); setAddQ(""); setAddResults([]); }}
                  >
                    ＋ {d.title}
                  </button>
                ))}
              </div>
            )}
          </div>

          {itemsLoading ? (
            <p className="viewsub">Loading…</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-3)", fontSize: 12 }}>
                    <th style={{ padding: "4px 8px", width: 28 }}>#</th>
                    <th style={{ padding: "4px 8px" }}>Deal</th>
                    <th style={{ padding: "4px 8px" }}>Reason</th>
                    <th style={{ padding: "4px 8px" }}>Pipeline</th>
                    <th style={{ padding: "4px 8px" }}>Stage</th>
                    <th style={{ padding: "4px 8px" }}>TZ</th>
                    <th style={{ padding: "4px 8px" }}>Phone</th>
                    <th style={{ padding: "4px 8px" }}>Status</th>
                    <th style={{ padding: "4px 8px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={it.dealId} style={{ borderTop: "1px solid var(--border)", opacity: it.removedAt ? 0.45 : 1 }}>
                      <td style={{ padding: "5px 8px", color: "var(--text-3)" }}>{i + 1}</td>
                      <td style={{ padding: "5px 8px" }}>
                        {it.pipedriveDealId ? (
                          <Link href={`/crm?deal=${it.pipedriveDealId}`} style={{ color: "var(--text-1)" }}>
                            {it.personName ?? it.title}
                          </Link>
                        ) : (it.personName ?? it.title)}
                        {it.flag && <div style={{ fontSize: 11.5, color: "#e8623a", marginTop: 2 }}>{it.flag}</div>}
                      </td>
                      <td style={{ padding: "5px 8px" }}>{badge(it.tierLabel)}</td>
                      <td style={{ padding: "5px 8px", color: "var(--text-2)", whiteSpace: "nowrap" }}>{it.pipelineName ?? "—"}</td>
                      <td style={{ padding: "5px 8px", color: "var(--text-2)", whiteSpace: "nowrap" }}>
                        {it.stageName ?? "—"}
                        {it.dealStatus && it.dealStatus !== "open" && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: it.dealStatus === "lost" ? "var(--crit)" : "var(--good)" }}>
                            ({it.dealStatus})
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "5px 8px", color: "var(--text-3)", textTransform: "capitalize" }}>{it.tzBucket ?? "—"}</td>
                      <td style={{ padding: "5px 8px", color: "var(--text-3)" }}>{it.phone ?? "—"}</td>
                      <td style={{ padding: "5px 8px" }}>
                        {it.removedAt ? <span style={{ color: "var(--bad)" }}>removed</span>
                          : it.calledAt ? <span style={{ color: "var(--good)" }}>✓ {it.disposition ?? "called"}</span>
                          : <span style={{ color: "var(--text-3)" }}>pending</span>}
                      </td>
                      <td style={{ padding: "5px 8px", textAlign: "right" }}>
                        {it.removedAt ? (
                          <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => itemOp("restore", it.dealId)}>restore</button>
                        ) : (
                          <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => itemOp("remove", it.dealId)} title="Remove from today's list">✕</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 && (
                    <tr><td colSpan={9} style={{ padding: 12, color: "var(--text-3)" }}>Empty list.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
