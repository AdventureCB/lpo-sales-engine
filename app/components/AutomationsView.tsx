"use client";

import { useCallback, useEffect, useState } from "react";

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Record<string, any>;
  conditions: any[];
  actions: Record<string, any>[];
  created_by: string;
}

interface Run {
  automation_id: string;
  status: string;
  detail: { event?: string; results?: string[]; reason?: string } | null;
  ran_at: string;
}

const TRIGGERS: [string, string][] = [
  ["signal_received", "Signal received (builder save / checkout)"],
  ["deal_created", "Deal created"],
  ["deal_stage_changed", "Deal stage changed"],
  ["inbound_sms", "Inbound text received"],
  ["hot_flag_created", "Deal flagged Hot"],
];

const ACTION_TYPES: [string, string][] = [
  ["send_sms", "Send SMS (via Quo)"],
  ["klaviyo_event", "Trigger Klaviyo flow (email)"],
  ["create_deal", "Create deal (find/create person, Klaviyo phone enrich)"],
  ["create_task", "Create task on deal"],
  ["add_note", "Add note to deal"],
  ["webhook", "Call a webhook (any API)"],
];

function describeTrigger(t: Record<string, any>): string {
  const label = TRIGGERS.find(([k]) => k === t.type)?.[1] ?? t.type;
  return t.signal_type ? `${label}: ${t.signal_type}` : label;
}

export function AutomationsView() {
  const [autos, setAutos] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("signal_received");
  const [signalType, setSignalType] = useState("builder_save");
  const [actionsJson, setActionsJson] = useState(
    '[\n  {\n    "type": "create_deal",\n    "title_template": "Saved Build - {{contact.name}}",\n    "pipedrive_stage_id": 44,\n    "enrich_phone_from_klaviyo": true,\n    "owner_strategy": "round_robin",\n    "owner_pool": [24081760, 24391245]\n  }\n]'
  );
  const [builderMsg, setBuilderMsg] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/crm/automations")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          setAutos(d.automations);
          setRuns(d.runs);
        })
        .catch((e) => setError(String(e))),
    []
  );
  useEffect(() => {
    void load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  const toggle = async (a: Automation) => {
    await fetch("/api/crm/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, enabled: !a.enabled }),
    });
    await load();
  };

  const remove = async (a: Automation) => {
    await fetch("/api/crm/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, delete: true }),
    });
    await load();
  };

  const create = async () => {
    let actions: unknown;
    try {
      actions = JSON.parse(actionsJson);
    } catch {
      setBuilderMsg("Actions JSON is invalid");
      return;
    }
    const trigger: Record<string, unknown> = { type: triggerType };
    if (triggerType === "signal_received") trigger.signal_type = signalType;
    const r = await fetch("/api/crm/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, trigger, actions }),
    }).catch(() => null);
    if (r?.ok) {
      setBuilderMsg("✓ Created (disabled) — review, then enable");
      setName("");
      setShowBuilder(false);
      await load();
    } else {
      setBuilderMsg("Create failed");
    }
  };

  const runsFor = (id: string) => runs.filter((r) => r.automation_id === id);

  if (error) return <div className="viewsub">Couldn’t load automations: {error}</div>;

  return (
    <>
      <h2 className="viewtitle">CRM · Automations</h2>
      <div className="viewsub">
        Trigger → conditions → actions, running on our own event engine (per-minute) · new
        automations start disabled ·{" "}
        <a href="/crm" style={{ color: "var(--accent-hover)" }}>back to deals</a>
      </div>

      <button className="btn primary" style={{ marginBottom: 18 }} onClick={() => setShowBuilder((v) => !v)}>
        {showBuilder ? "Close builder" : "＋ New automation"}
      </button>

      {showBuilder && (
        <div className="card" style={{ marginBottom: 18, maxWidth: 720 }}>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout started → text from rep line" />
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <div className="field" style={{ margin: 0, flex: 1 }}>
              <label>Trigger</label>
              <select className="vmsel" value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
                {TRIGGERS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>
            {triggerType === "signal_received" && (
              <div className="field" style={{ margin: 0, flex: 1 }}>
                <label>Signal</label>
                <select className="vmsel" value={signalType} onChange={(e) => setSignalType(e.target.value)}>
                  <option value="builder_save">3D builder save</option>
                  <option value="checkout_started">Checkout started</option>
                </select>
              </div>
            )}
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Actions (JSON — templates: {"{{contact.first_name}}, {{deal.title}}, {{event.*}}"})</label>
            <textarea
              value={actionsJson}
              onChange={(e) => setActionsJson(e.target.value)}
              rows={10}
              style={{ width: "100%", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 9, padding: 10, color: "var(--text-1)", fontSize: 12.5, fontFamily: "ui-monospace, monospace" }}
            />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 10 }}>
            Action types: {ACTION_TYPES.map(([k]) => k).join(" · ")}
          </div>
          <button className="btn primary" onClick={create} disabled={!name.trim()}>Create (disabled)</button>
          {builderMsg && <span style={{ fontSize: 12.5, color: "var(--text-2)", marginLeft: 10 }}>{builderMsg}</span>}
        </div>
      )}

      {autos.map((a) => {
        const rs = runsFor(a.id);
        return (
          <div className="card" style={{ marginBottom: 12 }} key={a.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div
                className={`toggle ${a.enabled ? "on" : ""}`}
                onClick={() => toggle(a)}
                title={a.enabled ? "Disable" : "Enable"}
              >
                <span className="tk" />
              </div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <b>{a.name}</b>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                  {describeTrigger(a.trigger)} → {a.actions.map((x) => x.type).join(", ")}
                  {" · "}{rs.length} recent runs
                  {rs.some((r) => r.status === "error") && <span style={{ color: "var(--crit)" }}> · ⚠ errors</span>}
                </div>
              </div>
              <button className="btn ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => remove(a)}>
                🗑
              </button>
            </div>
            {rs.length > 0 && (
              <div style={{ marginTop: 10, borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
                {rs.slice(0, 5).map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: r.status === "error" ? "var(--crit)" : "var(--text-3)", padding: "2px 0" }}>
                    {new Date(r.ran_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{" "}
                    · {r.status} · {(r.detail?.results ?? [r.detail?.reason ?? ""]).join(" | ")}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {autos.length === 0 && <div className="viewsub">No automations yet.</div>}
    </>
  );
}
