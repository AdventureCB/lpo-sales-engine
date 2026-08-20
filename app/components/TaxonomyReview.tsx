"use client";

import { useCallback, useEffect, useState } from "react";

interface Proposal {
  id: string;
  kind: string;
  target_key: string | null;
  current: any;
  proposed: Record<string, unknown>;
  rationale: string;
  evidence: string | null;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  archetype_edit: "✏️ Edit archetype",
  archetype_add: "➕ New archetype",
  archetype_retire: "🗄 Retire archetype",
  attribute_edit: "✏️ Edit attribute",
  attribute_add: "➕ New attribute",
  attribute_retire: "🗄 Retire attribute",
};

const fmt = (v: unknown): string =>
  Array.isArray(v) ? v.join("; ") : typeof v === "object" && v != null ? JSON.stringify(v) : String(v ?? "—");

/** AI taxonomy review: run the critic, approve/reject each proposal. */
export function TaxonomyReview() {
  const [data, setData] = useState<{ pending: Proposal[]; recent: any[]; everRun: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/taxonomy-review")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (bootstrap: boolean) => {
    setRunning(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/taxonomy-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", bootstrap }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setMsg(d.count === 0 ? `No changes warranted: ${d.noChangesReason ?? ""}` : `✓ ${d.count} proposal${d.count === 1 ? "" : "s"} — review below`);
      load();
    } catch (e) {
      setMsg(`⚠ ${e instanceof Error ? e.message : e}`);
    } finally {
      setRunning(false);
    }
  };

  const decide = async (id: string, approve: boolean) => {
    setBusyId(id);
    await fetch("/api/admin/taxonomy-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decide", id, approve }),
    }).catch(() => {});
    setBusyId(null);
    load();
  };

  if (!data) return null;
  const bootstrapNext = !data.everRun;

  return (
    <div className="card" style={{ maxWidth: 780, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>🧪 AI taxonomy review</h3>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>
          the critic reads corrections, outcomes &amp; tags, then proposes changes — nothing applies without your approval
        </span>
        <button className="btn primary" style={{ marginLeft: "auto", padding: "6px 14px", fontSize: 13.5 }} disabled={running} onClick={() => void run(bootstrapNext)}>
          {running ? "Reviewing… (~30s)" : bootstrapNext ? "🚀 Run first review (deep bootstrap)" : "Run taxonomy review"}
        </button>
      </div>
      {msg && <div style={{ fontSize: 13, color: msg.startsWith("⚠") ? "var(--crit)" : "var(--text-2)", marginTop: 8 }}>{msg}</div>}

      {data.pending.length > 0 && (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {data.pending.map((p) => {
            const changedKeys = Object.keys(p.proposed ?? {}).filter((k) => k !== "key");
            return (
              <div key={p.id} style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 13.5 }}>{KIND_LABEL[p.kind] ?? p.kind}</b>
                  {p.target_key && <span className="chip stage" style={{ fontSize: 11.5 }}>{p.target_key}</span>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button className="btn primary" style={{ padding: "4px 12px", fontSize: 12.5 }} disabled={busyId === p.id} onClick={() => void decide(p.id, true)}>
                      ✓ Approve
                    </button>
                    <button className="btn ghost" style={{ padding: "4px 12px", fontSize: 12.5 }} disabled={busyId === p.id} onClick={() => void decide(p.id, false)}>
                      ✕ Reject
                    </button>
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 6 }}>{p.rationale}</div>
                {p.evidence && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3 }}>Evidence: {p.evidence}</div>}
                <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                  {changedKeys.map((k) => (
                    <div key={k} style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ flexShrink: 0, width: 120, color: "var(--text-3)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</span>
                      <span style={{ minWidth: 0 }}>
                        {p.current?.[k] != null && String(fmt(p.current[k])) !== String(fmt((p.proposed as any)[k])) && (
                          <span style={{ color: "var(--text-3)", textDecoration: "line-through", marginRight: 6 }}>{fmt(p.current[k]).slice(0, 120)}</span>
                        )}
                        <span style={{ color: "var(--text-1)" }}>{fmt((p.proposed as any)[k]).slice(0, 400)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data.pending.length === 0 && data.recent.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 10 }}>
          Recent: {data.recent.slice(0, 5).map((r: any) => `${r.status === "approved" ? "✓" : "✕"} ${r.target_key ?? r.kind}`).join(" · ")}
        </div>
      )}
    </div>
  );
}
