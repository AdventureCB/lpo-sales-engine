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
  ["signal_received", "Klaviyo event (Shopify / Typeform / any metric)"],
  ["deal_created", "Deal created"],
  ["deal_stage_changed", "Deal stage changed"],
  ["inbound_sms", "Inbound text received"],
  ["hot_flag_created", "Deal flagged Hot"],
];

interface KMetric {
  id: string;
  name: string;
  integration: string | null;
  slug: string;
}

const ACTION_TYPES: [string, string][] = [
  ["create_deal", "Create deal"],
  ["send_sms", "Send SMS (via Quo)"],
  ["klaviyo_event", "Trigger Klaviyo flow (email)"],
  ["create_task", "Create task on deal"],
  ["add_note", "Add note to deal"],
  ["webhook", "Call a webhook (any API)"],
];

const REPS: [number, string][] = [
  [24081760, "Parker"],
  [24391245, "Jackson"],
  [24723797, "Cainen"],
];

const STAGE_OPTIONS: [number, string][] = [
  [44, "Intake ▸ Needs Qualification"],
  [45, "Intake ▸ Recovery"],
  [55, "Sales/Nurture ▸ Warm"],
  [54, "Sales/Nurture ▸ Cold"],
  [56, "Sales/Nurture ▸ Hot"],
  [62, "Re-Prospect ▸ Lead Pool"],
];

const QUO_LINES: [string, string][] = [
  ["PN4tAddEF7", "Parker's line"],
  ["PNQvoLc6PO", "Jackson's line"],
  ["PN2nRozOQb", "Customer Service"],
  ["PNZuEepf4x", "Primary"],
];

/** Default config per action type; the form edits these fields directly. */
function newAction(type: string): Record<string, any> {
  switch (type) {
    case "create_deal":
      return { type, title_template: "New Lead - {{contact.name}}", pipedrive_stage_id: 44, enrich_phone_from_klaviyo: true, skip_if_open_deal: true, owner_strategy: "round_robin", owner_pool: [24081760, 24391245] };
    case "send_sms":
      return { type, from: "PN2nRozOQb", to: "contact_phone", body_template: "Hi {{contact.first_name}}! " };
    case "klaviyo_event":
      return { type, metric_name: "LPO Automation: " };
    case "create_task":
      return { type, subject_template: "Follow up: {{deal.title}}", due_in_days: 0 };
    case "add_note":
      return { type, body_template: "" };
    case "webhook":
      return { type, url: "https://" };
    default:
      return { type };
  }
}

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
  const [metrics, setMetrics] = useState<KMetric[] | null>(null);
  const [metricId, setMetricId] = useState("");
  const [sample, setSample] = useState<Record<string, unknown> | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [actions, setActions] = useState<Record<string, any>[]>([newAction("create_deal")]);
  const [addActionType, setAddActionType] = useState("send_sms");

  const setActionField = (i: number, field: string, value: any) => {
    setActions((prev) => prev.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)));
  };
  const removeAction = (i: number) => setActions((prev) => prev.filter((_, idx) => idx !== i));
  const togglePoolRep = (i: number, repId: number) => {
    setActions((prev) =>
      prev.map((a, idx) => {
        if (idx !== i) return a;
        const pool: number[] = a.owner_pool ?? [];
        return { ...a, owner_pool: pool.includes(repId) ? pool.filter((r) => r !== repId) : [...pool, repId] };
      })
    );
  };
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

  // Load the live metric catalog when the builder opens on a signal trigger.
  useEffect(() => {
    if (showBuilder && triggerType === "signal_received" && !metrics) {
      fetch("/api/crm/klaviyo-metrics")
        .then((r) => r.json())
        .then((d) => setMetrics(d.metrics ?? []))
        .catch(() => setMetrics([]));
    }
  }, [showBuilder, triggerType, metrics]);

  // Fetch a sample event's fields whenever a metric is picked.
  useEffect(() => {
    if (!metricId) {
      setSample(null);
      return;
    }
    setSampleLoading(true);
    fetch(`/api/crm/klaviyo-metrics?sample=${metricId}`)
      .then((r) => r.json())
      .then((d) => setSample(d.sample ?? {}))
      .catch(() => setSample({}))
      .finally(() => setSampleLoading(false));
  }, [metricId]);

  const insertToken = (key: string) => {
    void navigator.clipboard?.writeText(`{{event.meta.${key}}}`);
    setBuilderMsg(`Copied {{event.meta.${key}}} — paste it into any template field`);
  };

  const create = async () => {
    if (actions.length === 0) {
      setBuilderMsg("Add at least one action");
      return;
    }
    for (const a of actions) {
      if (a.type === "create_deal" && a.owner_strategy === "round_robin" && (a.owner_pool ?? []).length === 0) {
        setBuilderMsg("Round-robin needs at least one rep in the pool");
        return;
      }
    }
    const trigger: Record<string, unknown> = { type: triggerType };
    if (triggerType === "signal_received") {
      const m = metrics?.find((x) => x.id === metricId);
      if (!m) {
        setBuilderMsg("Pick a metric for the trigger");
        return;
      }
      trigger.signal_type = m.slug;
      trigger.metric_name = m.name;
    }
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
              <div className="field" style={{ margin: 0, flex: 2 }}>
                <label>Event / metric (live from Klaviyo)</label>
                <select className="vmsel" value={metricId} onChange={(e) => setMetricId(e.target.value)}>
                  <option value="">{metrics ? "Choose an event…" : "Loading catalog…"}</option>
                  {(metrics ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.integration ?? "Klaviyo"} · {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {triggerType === "signal_received" && metricId && (
            <div style={{ background: "var(--surface-2)", borderRadius: 9, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 6 }}>
                Available data fields {sampleLoading ? "(loading sample…)" : "(from the latest real event — click to copy a template token)"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {sample && Object.keys(sample).length === 0 && !sampleLoading && (
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>No recent events for this metric.</span>
                )}
                {sample &&
                  Object.entries(sample).slice(0, 20).map(([k, v]) => (
                    <button
                      key={k}
                      className="btn ghost"
                      style={{ padding: "3px 8px", fontSize: 11.5 }}
                      title={`Example: ${String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 80)}`}
                      onClick={() => insertToken(k)}
                    >
                      {k}
                    </button>
                  ))}
              </div>
            </div>
          )}
          <div className="panel-h" style={{ marginTop: 6 }}>Actions (run in order)</div>
          {actions.map((a, i) => (
            <div key={i} style={{ background: "var(--surface-2)", borderRadius: 9, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <b style={{ fontSize: 13 }}>
                  {i + 1}. {ACTION_TYPES.find(([k]) => k === a.type)?.[1] ?? a.type}
                </b>
                <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => removeAction(i)}>✕</button>
              </div>

              {a.type === "create_deal" && (
                <>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label>Deal title (use copied field tokens)</label>
                    <input value={a.title_template} onChange={(e) => setActionField(i, "title_template", e.target.value)} />
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div className="field" style={{ margin: 0 }}>
                      <label>Stage</label>
                      <select className="vmsel" value={a.pipedrive_stage_id} onChange={(e) => setActionField(i, "pipedrive_stage_id", Number(e.target.value))}>
                        {STAGE_OPTIONS.map(([id, label]) => (
                          <option key={id} value={id}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label>Owner assignment</label>
                      <select
                        className="vmsel"
                        value={a.owner_strategy === "round_robin" ? "round_robin" : String(a.owner_pipedrive_id ?? "")}
                        onChange={(e) => {
                          if (e.target.value === "round_robin") {
                            setActionField(i, "owner_strategy", "round_robin");
                          } else {
                            setActions((prev) => prev.map((x, idx) => idx === i ? { ...x, owner_strategy: undefined, owner_pipedrive_id: Number(e.target.value) } : x));
                          }
                        }}
                      >
                        <option value="round_robin">Round-robin (rotate)</option>
                        {REPS.map(([id, label]) => (
                          <option key={id} value={id}>Always {label}</option>
                        ))}
                      </select>
                    </div>
                    {a.owner_strategy === "round_robin" && (
                      <div style={{ display: "flex", gap: 10, paddingBottom: 8 }}>
                        {REPS.map(([id, label]) => (
                          <label key={id} style={{ fontSize: 12.5, display: "flex", gap: 4, alignItems: "center", color: "var(--text-2)" }}>
                            <input type="checkbox" checked={(a.owner_pool ?? []).includes(id)} onChange={() => togglePoolRep(i, id)} />
                            {label}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
                    <label style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", color: "var(--text-2)" }}>
                      <input type="checkbox" checked={a.enrich_phone_from_klaviyo} onChange={(e) => setActionField(i, "enrich_phone_from_klaviyo", e.target.checked)} />
                      Enrich missing phone from Klaviyo
                    </label>
                    <label style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", color: "var(--text-2)" }}>
                      <input type="checkbox" checked={a.skip_if_open_deal} onChange={(e) => setActionField(i, "skip_if_open_deal", e.target.checked)} />
                      Skip if an open deal exists
                    </label>
                  </div>
                </>
              )}

              {a.type === "send_sms" && (
                <>
                  <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                    <div className="field" style={{ margin: 0, flex: 1 }}>
                      <label>From line</label>
                      <select className="vmsel" value={a.from} onChange={(e) => setActionField(i, "from", e.target.value)}>
                        {QUO_LINES.map(([id, label]) => (
                          <option key={id} value={id}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ margin: 0, flex: 1 }}>
                      <label>Send to</label>
                      <select className="vmsel" value={a.to} onChange={(e) => setActionField(i, "to", e.target.value)}>
                        <option value="contact_phone">Contact's phone</option>
                        <option value="event_phone">Phone from event</option>
                      </select>
                    </div>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label>Message</label>
                    <textarea
                      value={a.body_template}
                      onChange={(e) => setActionField(i, "body_template", e.target.value)}
                      rows={3}
                      style={{ width: "100%", background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, color: "var(--text-1)", fontSize: 13 }}
                    />
                  </div>
                </>
              )}

              {a.type === "klaviyo_event" && (
                <div className="field" style={{ margin: 0 }}>
                  <label>Metric name to fire (build a Klaviyo flow triggered by it — the flow sends the email)</label>
                  <input value={a.metric_name} onChange={(e) => setActionField(i, "metric_name", e.target.value)} />
                </div>
              )}

              {a.type === "create_task" && (
                <div style={{ display: "flex", gap: 10 }}>
                  <div className="field" style={{ margin: 0, flex: 2 }}>
                    <label>Task subject</label>
                    <input value={a.subject_template} onChange={(e) => setActionField(i, "subject_template", e.target.value)} />
                  </div>
                  <div className="field" style={{ margin: 0, flex: 1 }}>
                    <label>Due in (days)</label>
                    <input type="number" value={a.due_in_days} onChange={(e) => setActionField(i, "due_in_days", Number(e.target.value))} />
                  </div>
                </div>
              )}

              {a.type === "add_note" && (
                <div className="field" style={{ margin: 0 }}>
                  <label>Note</label>
                  <textarea
                    value={a.body_template}
                    onChange={(e) => setActionField(i, "body_template", e.target.value)}
                    rows={2}
                    style={{ width: "100%", background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, color: "var(--text-1)", fontSize: 13 }}
                  />
                </div>
              )}

              {a.type === "webhook" && (
                <div className="field" style={{ margin: 0 }}>
                  <label>URL (receives event + deal + contact as JSON)</label>
                  <input value={a.url} onChange={(e) => setActionField(i, "url", e.target.value)} />
                </div>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <select className="vmsel" style={{ width: "auto" }} value={addActionType} onChange={(e) => setAddActionType(e.target.value)}>
              {ACTION_TYPES.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <button className="btn ghost" style={{ padding: "8px 12px", fontSize: 13 }} onClick={() => setActions((prev) => [...prev, newAction(addActionType)])}>
              ＋ Add action
            </button>
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
