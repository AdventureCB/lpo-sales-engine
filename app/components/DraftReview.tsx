"use client";

import { useEffect, useState } from "react";

interface Proposal {
  id: string;
  kind: string;
  target_key: string | null;
  current: Record<string, unknown> | null;
  proposed: Record<string, unknown>;
  rationale: string;
  evidence: string | null;
  created_at: string;
}
interface StyleRule {
  id: string;
  channel: string;
  rule: string;
  enabled: boolean;
}

const KIND_LABEL: Record<string, string> = {
  theme_edit: "✏️ Edit theme",
  theme_add: "＋ New theme",
  theme_retire: "🗄 Retire theme",
  style_add: "＋ New style rule",
  style_retire: "🗄 Retire style rule",
};

/**
 * 🧪 Draft & theme review — the taxonomy-review pattern for generation:
 * the critic digests the draft ledger (use rates, edit similarity, 👎 notes)
 * and proposes bounded changes; every one is approved or rejected here.
 */
export function DraftReview() {
  const [pending, setPending] = useState<Proposal[]>([]);
  const [recent, setRecent] = useState<{ kind: string; target_key: string | null; status: string; rationale: string }[]>([]);
  const [rules, setRules] = useState<StyleRule[]>([]);
  const [drafts60d, setDrafts60d] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/admin/draft-review");
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      setPending(d.pending ?? []);
      setRecent(d.recent ?? []);
      setRules(d.rules ?? []);
      setDrafts60d(d.drafts60d ?? 0);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async () => {
    setBusy("run");
    setMsg(null);
    try {
      const r = await fetch("/api/admin/draft-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setMsg(d.proposals === 0 ? `✓ No changes warranted — ${d.noChanges}` : `✓ ${d.proposals} proposal${d.proposals === 1 ? "" : "s"} to review`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/draft-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decide", id, approve }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const fmt = (o: Record<string, unknown> | null) =>
    o
      ? Object.entries(o)
          .filter(([k]) => ["name", "intent", "prompt_direction", "channels", "rule", "channel", "sort_order", "enabled"].includes(k))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("+") : String(v)}`)
          .join("\n")
      : "";

  return (
    <div className="card" style={{ maxWidth: 980, marginTop: 18 }}>
      <div className="panel-h" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        🧪 Draft &amp; theme review
        <span style={{ fontWeight: 400, fontSize: 12.5, color: "var(--text-3)" }}>{drafts60d} drafts logged in 60d</span>
        <button className="btn" style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 13 }} disabled={busy === "run"} onClick={() => void run()}>
          {busy === "run" ? "Reviewing…" : "▶ Run draft review"}
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 10 }}>
        The critic digests how drafts actually performed (used vs. discarded, how heavily edited before sending, 👎 notes, freeform directions) and
        proposes theme edits + capped style rules. Nothing applies without your approval — same model as the taxonomy review.
        {msg && <span style={{ marginLeft: 8, color: msg.startsWith("✓") ? "var(--good)" : "var(--crit)" }}>{msg}</span>}
      </div>

      {pending.length > 0 && (
        <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
          {pending.map((p) => (
            <div key={p.id} style={{ background: "var(--surface-2)", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ fontSize: 13.5 }}>{KIND_LABEL[p.kind] ?? p.kind}</b>
                {p.target_key && <span className="chip stage" style={{ fontSize: 11.5 }}>{p.target_key}</span>}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-2)", margin: "6px 0" }}>{p.rationale}</div>
              {p.evidence && <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>Evidence: {p.evidence}</div>}
              <div style={{ display: "grid", gridTemplateColumns: p.current ? "1fr 1fr" : "1fr", gap: 10, fontSize: 12.5 }}>
                {p.current && (
                  <div style={{ whiteSpace: "pre-wrap", color: "var(--text-3)", background: "var(--surface-1)", borderRadius: 8, padding: "8px 10px" }}>
                    {fmt(p.current) || "(current)"}
                  </div>
                )}
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text-1)", background: "var(--surface-1)", borderRadius: 8, padding: "8px 10px" }}>
                  {fmt(p.proposed) || "(no fields)"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn primary" style={{ padding: "4px 14px", fontSize: 13 }} disabled={busy === p.id} onClick={() => void decide(p.id, true)}>
                  Approve
                </button>
                <button className="btn ghost" style={{ padding: "4px 14px", fontSize: 13 }} disabled={busy === p.id} onClick={() => void decide(p.id, false)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rules.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>
            Active style rules ({rules.filter((r) => r.enabled).length}/10)
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            {rules.filter((r) => r.enabled).map((r) => (
              <div key={r.id} style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                <span className="chip stage" style={{ fontSize: 10.5, marginRight: 6 }}>{r.channel}</span>
                {r.rule}
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          Recent: {recent.map((r, i) => `${r.status === "approved" ? "✓" : "✕"} ${KIND_LABEL[r.kind] ?? r.kind}${r.target_key ? ` (${r.target_key})` : ""}`).join(" · ")}
        </div>
      )}
    </div>
  );
}
