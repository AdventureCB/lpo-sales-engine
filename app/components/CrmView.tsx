"use client";

import { useCallback, useEffect, useState } from "react";

interface Deal {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  owner_pipedrive_id: number | null;
  last_activity_at: string | null;
  updated_at: string;
  pd_add_time: string | null;
  crm_stages: { name: string; pipeline_id: string; crm_pipelines: { name: string } | null } | null;
  crm_contacts: { name: string; phones: { value: string; e164?: string }[] } | null;
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

const COLUMNS: [string, string][] = [
  ["title", "Deal"],
  ["stage_changed", "Stage"],
  ["value", "Value"],
  ["activity", "Last activity"],
  ["updated", "Updated"],
];

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function CrmView() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState("");
  const [stage, setStage] = useState("");
  const [status, setStatus] = useState("open");
  const [owner, setOwner] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [importing, setImporting] = useState(false);
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
  }, [page, sort, dir, status, stage, owner, search]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    void loadDeals();
  }, [loadDeals]);

  const runImport = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const r = await fetch("/api/crm/import", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        setImportMsg(d.error ?? `HTTP ${r.status}`);
      } else {
        const c = d.state?.counts ?? {};
        setImportMsg(
          d.done
            ? `✓ Import complete — ${c.persons ?? 0} contacts, ${c.deals ?? 0} deals`
            : `Chunk done (phase: ${d.state.phase}) — run again to continue`
        );
      }
      await loadMeta();
      await loadDeals();
    } catch (e) {
      setImportMsg(String(e));
    } finally {
      setImporting(false);
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
        Native system of record (admin preview) · mirrored from Pipedrive continuously ·{" "}
        {meta ? `${meta.mirror.deals.toLocaleString()} deals, ${meta.mirror.contacts.toLocaleString()} contacts mirrored` : "…"}{" "}
        · <a href="/crm/automations" style={{ color: "var(--accent-hover)" }}>⚙ Automations</a>
      </div>

      <div className="card" style={{ padding: "10px 14px", marginBottom: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="panel-h" style={{ margin: 0 }}>Mirror</span>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={runImport} disabled={importing}>
          {importing ? "Importing…" : "⟳ Run import chunk"}
        </button>
        {meta?.mirror.importState && (
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            phase: {meta.mirror.importState.phase} ·{" "}
            {Object.entries(meta.mirror.importState.counts ?? {})
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </span>
        )}
        {importMsg && <span style={{ fontSize: 12, color: "var(--text-2)" }}>{importMsg}</span>}
      </div>

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
        <input
          className="vmsel"
          style={{ width: 220 }}
          placeholder="Search deals…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (setPage(0), void loadDeals())}
        />
      </div>

      {selected.size > 0 && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ fontSize: 13.5 }}>⚡ {selected.size} selected</b>
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
          <button className="btn primary" style={{ padding: "8px 14px", fontSize: 13 }} onClick={createSprint} disabled={!sprintName.trim()}>
            Create sprint
          </button>
          <button className="btn ghost" style={{ padding: "8px 12px", fontSize: 13 }} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span style={{ color: "var(--text-3)", fontSize: 12 }}>or</span>
          <select className="vmsel" style={{ width: "auto" }} value={assignOwner} onChange={(e) => setAssignOwner(e.target.value)}>
            <option value="">Assign owner…</option>
            <option value="24081760">→ Parker</option>
            <option value="24391245">→ Jackson</option>
            <option value="24723797">→ Cainen</option>
          </select>
          <button className="btn ghost" style={{ padding: "8px 14px", fontSize: 13 }} onClick={bulkAssign} disabled={!assignOwner}>
            Assign {selected.size}
          </button>
        </div>
      )}
      {sprintMsg && <div className="viewsub" style={{ color: "var(--good)" }}>{sprintMsg}</div>}

      <div className="card" style={{ padding: "6px 12px" }}>
        <table className="data">
          <thead>
            <tr>
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
              {COLUMNS.map(([key, label]) => (
                <th key={key} style={{ cursor: "pointer" }} onClick={() => clickSort(key)}>
                  {label} {sort === key ? (dir === "desc" ? "↓" : "↑") : ""}
                </th>
              ))}
              <th>Owner</th>
              <th>Contact</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} style={{ color: "var(--text-3)", padding: "16px 10px" }}>Loading…</td></tr>
            )}
            {!loading && deals.length === 0 && (
              <tr><td colSpan={8} style={{ color: "var(--text-3)", padding: "16px 10px" }}>
                No deals in the mirror yet — run the import above.
              </td></tr>
            )}
            {!loading && deals.map((d) => (
              <tr key={d.id}>
                <td>
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} />
                </td>
                <td>
                  <a href={`/crm/deal/${d.id}`} style={{ color: "var(--text-1)", textDecoration: "none" }}>
                    <b>{d.title}</b>
                  </a>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {d.crm_stages?.name ?? "—"}
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>{d.crm_stages?.crm_pipelines?.name}</div>
                </td>
                <td className="money">{d.value_cents != null ? `$${Math.round(d.value_cents / 100).toLocaleString()}` : "—"}</td>
                <td style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>{fmtDate(d.last_activity_at)}</td>
                <td style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>{fmtDate(d.updated_at)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{d.owner_pipedrive_id ? OWNER_NAMES[d.owner_pipedrive_id] ?? d.owner_pipedrive_id : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {d.crm_contacts?.name ?? "—"}
                  {d.crm_contacts?.phones?.[0] && (
                    <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                      {d.crm_contacts.phones[0].e164 ?? d.crm_contacts.phones[0].value}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5 }} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Prev
        </button>
        <span style={{ fontSize: 13, color: "var(--text-2)" }}>
          {total.toLocaleString()} deals · page {page + 1} / {Math.max(1, Math.ceil(total / 50))}
        </span>
        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 12.5 }} disabled={(page + 1) * 50 >= total} onClick={() => setPage((p) => p + 1)}>
          Next →
        </button>
      </div>
    </>
  );
}
