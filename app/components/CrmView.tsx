"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Deal {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  owner_pipedrive_id: number | null;
  deal_sources: { name: string } | null;
  last_activity_at: string | null;
  updated_at: string;
  pd_add_time: string | null;
  truck_model: string | null;
  crm_stages: { name: string; pipeline_id: string; crm_pipelines: { name: string } | null } | null;
  crm_contacts: { name: string; phones: { value: string; e164?: string }[]; tz_offset: number | null } | null;
}

interface Meta {
  pipelines: { id: string; name: string }[];
  stages: { id: string; pipeline_id: string; name: string }[];
  mirror: {
    deals: number;
    contacts: number;
    importState: { phase: string; counts: Record<string, number> } | null;
  };
}

const OWNERS: { id: string; label: string }[] = [
  { id: "", label: "Any owner" },
  { id: "24081760", label: "Parker" },
  { id: "24391245", label: "Jackson" },
  { id: "24723797", label: "Cainen" },
];

const OWNER_NAMES: Record<number, string> = {
  24081760: "Parker",
  24391245: "Jackson",
  24723797: "Cainen",
  23851101: "Gabi",
  23851090: "Kecia",
};

/** Three caller-facing buckets from the raw UTC offset. West = PT/MT/AK/HI
 * (≤ −7), Central = −6, East = ET/AT (≥ −5). */
function tzRegion(offset: number | null | undefined): string | null {
  if (offset == null) return null;
  if (offset <= -7) return "West";
  if (offset === -6) return "Central";
  return "East";
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface ColDef {
  key: string;
  label: string;
  sortKey?: string; // header sort → /api/crm/deals sort param
  nowrap?: boolean;
  render: (d: Deal) => React.ReactNode;
}

// The full column catalog. Visibility + order are user-configurable.
const ALL_COLUMNS: ColDef[] = [
  {
    key: "title",
    label: "Deal",
    sortKey: "title",
    render: (d) => (
      <a href={`/crm/deal/${d.id}`} style={{ color: "var(--text-1)", textDecoration: "none" }}>
        <b>{d.title}</b>
      </a>
    ),
  },
  { key: "tz", label: "TZ", sortKey: "timezone", nowrap: true, render: (d) => <span style={{ color: "var(--text-2)", fontWeight: 650 }}>{tzRegion(d.crm_contacts?.tz_offset) ?? "—"}</span> },
  {
    key: "stage",
    label: "Stage",
    sortKey: "stage_changed",
    nowrap: true,
    render: (d) => (
      <>
        {d.crm_stages?.name ?? "—"}
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>{d.crm_stages?.crm_pipelines?.name}</div>
      </>
    ),
  },
  { key: "value", label: "Value", sortKey: "value", render: (d) => (d.value_cents != null ? `$${Math.round(d.value_cents / 100).toLocaleString()}` : "—") },
  { key: "activity", label: "Last activity", sortKey: "activity", nowrap: true, render: (d) => <span style={{ color: "var(--text-3)" }}>{fmtDate(d.last_activity_at)}</span> },
  { key: "updated", label: "Updated", sortKey: "updated", nowrap: true, render: (d) => <span style={{ color: "var(--text-3)" }}>{fmtDate(d.updated_at)}</span> },
  { key: "created", label: "Created", sortKey: "created", nowrap: true, render: (d) => <span style={{ color: "var(--text-3)" }}>{fmtDate(d.pd_add_time)}</span> },
  { key: "source", label: "Source", nowrap: true, render: (d) => <span style={{ color: "var(--text-2)" }}>{d.deal_sources?.name ?? "—"}</span> },
  { key: "owner", label: "Owner", nowrap: true, render: (d) => (d.owner_pipedrive_id ? OWNER_NAMES[d.owner_pipedrive_id] ?? d.owner_pipedrive_id : "—") },
  { key: "truck", label: "Truck", nowrap: true, render: (d) => <span style={{ color: "var(--text-2)" }}>{d.truck_model ?? "—"}</span> },
  {
    key: "contact",
    label: "Contact",
    nowrap: true,
    render: (d) => (
      <>
        {d.crm_contacts?.name ?? "—"}
        {d.crm_contacts?.phones?.[0] && (
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>
            {d.crm_contacts.phones[0].e164 ?? d.crm_contacts.phones[0].value}
          </div>
        )}
      </>
    ),
  },
];

const COL_MAP = new Map(ALL_COLUMNS.map((c) => [c.key, c]));
const DEFAULT_COLS = ["title", "tz", "stage", "value", "activity", "updated", "source", "owner", "contact"];
const COLS_LS_KEY = "crmColumns";

/** Persisted column config = ordered {key, visible}. Reconciled with the
 * catalog so newly-added columns appear (hidden) instead of vanishing. */
function loadColConfig(): { key: string; visible: boolean }[] {
  let saved: { key: string; visible: boolean }[] = [];
  try {
    const raw = localStorage.getItem(COLS_LS_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(saved) || saved.length === 0) {
    return ALL_COLUMNS.map((c) => ({ key: c.key, visible: DEFAULT_COLS.includes(c.key) }));
  }
  const seen = new Set(saved.map((c) => c.key));
  const reconciled = saved.filter((c) => COL_MAP.has(c.key));
  for (const c of ALL_COLUMNS) if (!seen.has(c.key)) reconciled.push({ key: c.key, visible: false });
  return reconciled;
}

export function CrmView({ isAdmin, defaultOwner }: { isAdmin: boolean; defaultOwner: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState("");
  const [stage, setStage] = useState("");
  const [status, setStatus] = useState("open");
  const [owner, setOwner] = useState(defaultOwner);
  const [srcFilter, setSrcFilter] = useState("");
  const [tzFilter, setTzFilter] = useState("");
  const [colConfig, setColConfig] = useState<{ key: string; visible: boolean }[]>([]);
  const [colsOpen, setColsOpen] = useState(false);
  // Pointer-based drag (works in the WKWebView companion; HTML5 DnD doesn't).
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dropIdxRef = useRef<number | null>(null);
  const colConfigRef = useRef<{ key: string; visible: boolean }[]>([]);
  useEffect(() => setColConfig(loadColConfig()), []);
  useEffect(() => { colConfigRef.current = colConfig; }, [colConfig]);
  const saveCols = (next: { key: string; visible: boolean }[]) => {
    setColConfig(next);
    try {
      localStorage.setItem(COLS_LS_KEY, JSON.stringify(next));
    } catch {}
  };
  const toggleCol = (key: string) =>
    saveCols(colConfig.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)));

  const startColDrag = (key: string, e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return; // let the checkbox click
    e.preventDefault();
    setDragKey(key);
    const computeDrop = (clientY: number) => {
      const list = colConfigRef.current;
      let idx = list.length;
      for (let i = 0; i < list.length; i++) {
        const el = rowRefs.current.get(list[i].key);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) { idx = i; break; }
      }
      dropIdxRef.current = idx;
      setDropIdx(idx);
    };
    computeDrop(e.clientY);
    const onMove = (ev: PointerEvent) => computeDrop(ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const list = colConfigRef.current;
      const from = list.findIndex((c) => c.key === key);
      const insert = dropIdxRef.current;
      if (from >= 0 && insert != null) {
        const next = [...list];
        const [moved] = next.splice(from, 1);
        next.splice(from < insert ? insert - 1 : insert, 0, moved);
        saveCols(next);
      }
      setDragKey(null);
      setDropIdx(null);
      dropIdxRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const visibleCols = colConfig.filter((c) => c.visible).map((c) => COL_MAP.get(c.key)!).filter(Boolean);
  const colCount = visibleCols.length + (isAdmin ? 1 : 0);
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [importing, setImporting] = useState(false);
  const [pdSyncing, setPdSyncing] = useState(false);
  const [pdPending, setPdPending] = useState(0);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sprintName, setSprintName] = useState("");
  const [sprintOwner, setSprintOwner] = useState("parker@lonepeakoverland.com");
  const [sprintMsg, setSprintMsg] = useState<string | null>(null);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [assignOwner, setAssignOwner] = useState("");

  const bulkAssign = async () => {
    if (!assignOwner || selected.size === 0) return;
    const ids = [...selected];
    let ok = 0;
    for (const id of ids) {
      const r = await fetch("/api/crm/deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ownerPipedriveId: Number(assignOwner) }),
      }).catch(() => null);
      if (r?.ok) ok++;
    }
    setSprintMsg(`✓ Assigned ${ok}/${ids.length} deals`);
    setSelected(new Set());
    setAssignOwner("");
    setTimeout(() => setSprintMsg(null), 5000);
    await loadDeals();
  };

  const createSprint = async () => {
    if (!sprintName.trim() || selected.size === 0) return;
    const r = await fetch("/api/crm/sprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sprintName.trim(), owner: sprintOwner, dealIds: [...selected] }),
    }).catch(() => null);
    if (r?.ok) {
      setSprintMsg(`✓ Sprint "${sprintName.trim()}" created for ${sprintOwner.split("@")[0]} (${selected.size} deals) — it's in their dialer now`);
      setSelected(new Set());
      setSprintName("");
    } else {
      setSprintMsg("Sprint creation failed");
    }
    setTimeout(() => setSprintMsg(null), 6000);
  };

  const loadMeta = useCallback(
    () =>
      fetch("/api/crm/meta")
        .then((r) => r.json())
        .then(setMeta)
        .catch((e) => setError(String(e))),
    []
  );

  const loadDeals = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), sort, dir });
    if (status) params.set("status", status);
    if (stage) params.set("stageId", stage);
    if (owner) params.set("owner", owner);
    if (srcFilter) params.set("source", srcFilter);
    if (tzFilter) params.set("tz", tzFilter);
    if (search.trim()) params.set("q", search.trim());
    try {
      const r = await fetch(`/api/crm/deals?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setDeals(d.deals);
      setTotal(d.total);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [page, sort, dir, status, stage, owner, srcFilter, tzFilter, search]);

  useEffect(() => {
    fetch("/api/crm/sources")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSources(d.sources ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    void loadDeals();
  }, [loadDeals]);

  useEffect(() => {
    const poll = () =>
      fetch("/api/crm/pd-sync")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setPdPending(d.pending ?? 0))
        .catch(() => {});
    void poll();
    const iv = setInterval(poll, 60_000);
    return () => clearInterval(iv);
  }, []);

  const runPdSync = async () => {
    setPdSyncing(true);
    setImportMsg(null);
    try {
      const r = await fetch("/api/crm/pd-sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setImportMsg(d.error ?? `HTTP ${r.status}`);
      } else {
        setPdPending(d.pending ?? 0);
        setImportMsg(
          d.rateLimited
            ? `Synced ${d.processed} — Pipedrive daily budget hit, ${d.pending} still queued (auto-retries)`
            : `✓ Synced ${d.processed} to Pipedrive · ${d.pending} pending${d.failed ? ` · ${d.failed} failed` : ""}`
        );
      }
    } catch (e) {
      setImportMsg(String(e));
    } finally {
      setPdSyncing(false);
    }
  };

  const runImport = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      // Each call imports a bounded, cursor-saved chunk — keep calling until
      // the server reports done, so one click walks the whole account.
      for (let i = 0; i < 200; i++) {
        const r = await fetch("/api/crm/import", { method: "POST" });
        const d = await r.json();
        if (!r.ok) {
          setImportMsg(`${d.error ?? `HTTP ${r.status}`} — progress is saved; click again to resume`);
          return;
        }
        const c = d.state?.counts ?? {};
        const progress = `${c.persons ?? 0} contacts · ${c.deals ?? 0} deals · ${c.notes ?? 0} notes · ${c.activities ?? 0} activities · ${c.emails ?? 0} emails · ${c.changes ?? 0} changes`;
        if (d.done) {
          setImportMsg(`✓ Import complete — ${progress}`);
          return;
        }
        setImportMsg(`Importing… (${d.state.phase}) ${progress}`);
      }
    } catch (e) {
      setImportMsg(`${String(e)} — progress is saved; click Import again to resume`);
    } finally {
      setImporting(false);
      await loadMeta();
      await loadDeals();
    }
  };

  const clickSort = (key: string) => {
    if (sort === key) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSort(key);
      setDir("desc");
    }
    setPage(0);
  };

  const stagesForPipeline = (meta?.stages ?? []).filter(
    (s) => !pipeline || s.pipeline_id === pipeline
  );

  if (error) return <div className="viewsub">Couldn’t load CRM: {error}</div>;

  return (
    <>
      <h2 className="viewtitle">CRM · Deals</h2>
      <div className="viewsub">
        Native system of record · mirrored from Pipedrive continuously ·{" "}
        {meta ? `${meta.mirror.deals.toLocaleString()} deals, ${meta.mirror.contacts.toLocaleString()} contacts mirrored` : "…"}{" "}
        {isAdmin && (
          <>
            · <a href="/crm/automations" style={{ color: "var(--accent-hover)" }}>⚙ Automations</a>
          </>
        )}
      </div>

      {isAdmin && (
      <div className="card" style={{ padding: "10px 14px", marginBottom: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="panel-h" style={{ margin: 0 }}>Mirror</span>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13.5 }} onClick={runImport} disabled={importing}>
          {importing ? "Importing…" : "⟳ Run import chunk"}
        </button>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13.5 }} onClick={runPdSync} disabled={pdSyncing}>
          {pdSyncing ? "Syncing…" : `⇅ Sync Pipedrive${pdPending > 0 ? ` (${pdPending})` : ""}`}
        </button>
        {meta?.mirror.importState && (
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>
            phase: {meta.mirror.importState.phase} ·{" "}
            {Object.entries(meta.mirror.importState.counts ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </span>
        )}
        {importMsg && <span style={{ fontSize: 13, color: "var(--text-2)" }}>{importMsg}</span>}
      </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <select className="vmsel" style={{ width: "auto" }} value={pipeline} onChange={(e) => { setPipeline(e.target.value); setStage(""); setPage(0); }}>
          <option value="">All pipelines</option>
          {(meta?.pipelines ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={stage} onChange={(e) => { setStage(e.target.value); setPage(0); }}>
          <option value="">All stages</option>
          {stagesForPipeline.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="open">Open</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
          <option value="">Any status</option>
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={owner} onChange={(e) => { setOwner(e.target.value); setPage(0); }}>
          {OWNERS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={srcFilter} onChange={(e) => { setSrcFilter(e.target.value); setPage(0); }}>
          <option value="">Any source</option>
          <option value="none">— No source —</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={tzFilter} onChange={(e) => { setTzFilter(e.target.value); setPage(0); }}>
          <option value="">Any timezone</option>
          <option value="west">🌎 West</option>
          <option value="central">🌎 Central</option>
          <option value="east">🌎 East</option>
        </select>
        <input
          className="vmsel"
          style={{ width: 220 }}
          placeholder="Search deals…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (setPage(0), void loadDeals())}
        />
      </div>

      {isAdmin && selected.size > 0 && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ fontSize: 14.5 }}>⚡ {selected.size} selected</b>
          <input
            className="vmsel"
            style={{ width: 200 }}
            placeholder="Sprint name…"
            value={sprintName}
            onChange={(e) => setSprintName(e.target.value)}
          />
          <select className="vmsel" style={{ width: "auto" }} value={sprintOwner} onChange={(e) => setSprintOwner(e.target.value)}>
            <option value="parker@lonepeakoverland.com">Parker</option>
            <option value="jackson@lonepeakoverland.com">Jackson</option>
            <option value="cainen@lonepeakoverland.com">Cainen</option>
            <option value="kyle@lonepeakoverland.com">Kyle</option>
          </select>
          <button className="btn primary" style={{ padding: "8px 14px", fontSize: 14 }} onClick={createSprint} disabled={!sprintName.trim()}>
            Create sprint
          </button>
          <button className="btn ghost" style={{ padding: "8px 12px", fontSize: 14 }} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span style={{ color: "var(--text-3)", fontSize: 13 }}>or</span>
          <select className="vmsel" style={{ width: "auto" }} value={assignOwner} onChange={(e) => setAssignOwner(e.target.value)}>
            <option value="">Assign owner…</option>
            <option value="24081760">→ Parker</option>
            <option value="24391245">→ Jackson</option>
            <option value="24723797">→ Cainen</option>
          </select>
          <button className="btn ghost" style={{ padding: "8px 14px", fontSize: 14 }} onClick={bulkAssign} disabled={!assignOwner}>
            Assign {selected.size}
          </button>
        </div>
      )}
      {sprintMsg && <div className="viewsub" style={{ color: "var(--good)" }}>{sprintMsg}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8, position: "relative" }}>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setColsOpen((v) => !v)}>
          ⚙ Columns
        </button>
        {colsOpen && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 59 }} onClick={() => setColsOpen(false)} />
            <div className="dropdown-menu" style={{ left: "auto", right: 0, width: 240, top: "calc(100% + 4px)" }}>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "2px 8px 6px" }}>
                Check to show · drag ⠿ to reorder
              </div>
              {colConfig.map((c, i) => {
                const def = COL_MAP.get(c.key);
                if (!def) return null;
                return (
                  <div key={c.key}>
                    {dragKey && dropIdx === i && (
                      <div style={{ height: 2, background: "var(--accent)", borderRadius: 2, margin: "1px 6px" }} />
                    )}
                    <div
                      ref={(el) => {
                        if (el) rowRefs.current.set(c.key, el);
                        else rowRefs.current.delete(c.key);
                      }}
                      onPointerDown={(e) => startColDrag(c.key, e)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 8px",
                        borderRadius: 7,
                        cursor: "grab",
                        touchAction: "none",
                        userSelect: "none",
                        opacity: dragKey === c.key ? 0.4 : 1,
                        background: dragKey === c.key ? "var(--surface-3)" : "transparent",
                      }}
                    >
                      <span style={{ color: "var(--text-3)", fontSize: 14 }}>⠿</span>
                      <input
                        type="checkbox"
                        checked={c.visible}
                        onChange={() => toggleCol(c.key)}
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer" }}
                      />
                      <span style={{ fontSize: 13.5 }}>{def.label}</span>
                    </div>
                  </div>
                );
              })}
              {dragKey && dropIdx === colConfig.length && (
                <div style={{ height: 2, background: "var(--accent)", borderRadius: 2, margin: "1px 6px" }} />
              )}
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ padding: "6px 12px", overflowX: "auto" }}>
        <table className="data">
          <thead>
            <tr>
              {isAdmin && (
                <th style={{ width: 30 }}>
                  <input
                    type="checkbox"
                    checked={deals.length > 0 && deals.every((d) => selected.has(d.id))}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        deals.forEach((d) => (e.target.checked ? next.add(d.id) : next.delete(d.id)));
                        return next;
                      })
                    }
                  />
                </th>
              )}
              {visibleCols.map((col) => (
                <th
                  key={col.key}
                  style={{ cursor: col.sortKey ? "pointer" : "default" }}
                  onClick={() => col.sortKey && clickSort(col.sortKey)}
                >
                  {col.label} {col.sortKey && sort === col.sortKey ? (dir === "desc" ? "↓" : "↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={colCount} style={{ color: "var(--text-3)", padding: "16px 10px" }}>Loading…</td></tr>
            )}
            {!loading && deals.length === 0 && (
              <tr><td colSpan={colCount} style={{ color: "var(--text-3)", padding: "16px 10px" }}>
                No deals match.
              </td></tr>
            )}
            {!loading && deals.map((d) => (
              <tr key={d.id}>
                {isAdmin && (
                  <td>
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} />
                  </td>
                )}
                {visibleCols.map((col) => (
                  <td key={col.key} style={col.nowrap ? { whiteSpace: "nowrap" } : undefined} className={col.key === "value" ? "money" : undefined}>
                    {col.render(d)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13.5 }} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Prev
        </button>
        <span style={{ fontSize: 14, color: "var(--text-2)" }}>
          {total.toLocaleString()} deals · page {page + 1} / {Math.max(1, Math.ceil(total / 50))}
        </span>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13.5 }} disabled={(page + 1) * 50 >= total} onClick={() => setPage((p) => p + 1)}>
          Next →
        </button>
      </div>
    </>
  );
}
