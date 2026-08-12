"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/** Admin configuration: rep calling numbers + daily goals. */

interface Rep {
  id: string;
  name: string;
  quo_phone_number: string | null;
  telnyx_number: string | null;
  active?: boolean;
  daily_dial_goal: number;
  daily_talk_goal_min: number;
  bonus_dial_goal: number | null;
}

export function SettingsView() {
  const [reps, setReps] = useState<Rep[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // Local edit buffer so typing a goal doesn't fire a save per keystroke.
  const [goalEdits, setGoalEdits] = useState<Record<string, { dial: string; talk: string; bonus: string }>>({});

  const load = useCallback(
    () =>
      fetch("/api/admin/settings")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          setReps(d.reps);
          setNumbers(d.telnyxNumbers);
        })
        .catch((e) => setMsg(String(e))),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    setMsg(null);
    const r = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setMsg(r?.ok ? "✓ Saved" : "Save failed");
    await load();
  };

  const assign = (repId: string, telnyxNumber: string) => post({ repId, telnyxNumber });

  const saveGoals = (r: Rep) => {
    const edit = goalEdits[r.id];
    if (!edit) return;
    const dial = Number(edit.dial);
    const talk = Number(edit.talk);
    const bonus = edit.bonus.trim() === "" ? 0 : Number(edit.bonus); // empty = derived
    const bonusChanged = bonus !== (r.bonus_dial_goal ?? 0);
    if (dial === r.daily_dial_goal && talk === r.daily_talk_goal_min && !bonusChanged) return;
    void post({
      repId: r.id,
      ...(dial > 0 && dial !== r.daily_dial_goal ? { dialGoal: dial } : {}),
      ...(talk > 0 && talk !== r.daily_talk_goal_min ? { talkGoalMin: talk } : {}),
      ...(bonusChanged ? { bonusDialGoal: bonus } : {}),
    });
  };

  const editFor = (r: Rep) =>
    goalEdits[r.id] ?? {
      dial: String(r.daily_dial_goal),
      talk: String(r.daily_talk_goal_min),
      bonus: r.bonus_dial_goal != null ? String(r.bonus_dial_goal) : "",
    };

  const setEdit = (r: Rep, patch: Partial<{ dial: string; talk: string; bonus: string }>) =>
    setGoalEdits((g) => ({ ...g, [r.id]: { ...editFor(r), ...patch } }));

  const assignedElsewhere = (num: string, repId: string) =>
    reps.some((r) => r.id !== repId && r.telnyx_number === num);

  const goalInput: React.CSSProperties = { width: 64, textAlign: "right", padding: "6px 8px" };

  return (
    <>
      <h2 className="viewtitle">Settings</h2>
      <div className="viewsub" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        Team configuration
        <Link href="/settings/profile" className="btn ghost" style={{ padding: "4px 12px", fontSize: 13 }}>
          👤 My profile →
        </Link>
        {msg && <span style={{ color: "var(--text-2)" }}>{msg}</span>}
      </div>

      <div className="card" style={{ maxWidth: 680, marginBottom: 18 }}>
        <div className="panel-h">Rep calling numbers</div>
        {reps.map((r) => (
          <div className="stmt-row" key={r.id} style={{ alignItems: "center" }}>
            <div>
              <b style={{ fontSize: 14.5 }}>
                {r.name}
                {r.active === false && (
                  <span style={{ fontSize: 12.5, color: "var(--text-3)", fontWeight: 600 }}> · admin</span>
                )}
              </b>
              <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>
                Quo: {r.quo_phone_number ?? "—"} (unchanged until port)
              </div>
            </div>
            <select
              className="vmsel"
              style={{ width: "auto" }}
              value={r.telnyx_number ?? ""}
              onChange={(e) => assign(r.id, e.target.value)}
            >
              <option value="">No Telnyx number (account default)</option>
              {numbers.map((n) => (
                <option key={n} value={n} disabled={assignedElsewhere(n, r.id)}>
                  {n}
                  {assignedElsewhere(n, r.id) ? " (assigned)" : ""}
                </option>
              ))}
            </select>
          </div>
        ))}
        {numbers.length === 0 && (
          <div style={{ fontSize: 14, color: "var(--text-3)", marginTop: 8 }}>
            No Telnyx numbers on the account yet — buy numbers in the Telnyx portal (or port the Quo
            numbers at migration) and they appear here.
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 680 }}>
        <div className="panel-h">Daily goals</div>
        <div style={{ fontSize: 13.5, color: "var(--text-3)", marginBottom: 10 }}>
          Drives each rep’s momentum bars and streak on the dialer. Saves when you click away.
        </div>
        {reps
          .filter((r) => r.active !== false)
          .map((r) => (
            <div className="stmt-row" key={r.id} style={{ alignItems: "center" }}>
              <b style={{ fontSize: 14.5 }}>{r.name}</b>
              <span style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 13.5, color: "var(--text-3)" }}>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="vmsel"
                    style={goalInput}
                    type="number"
                    min={1}
                    value={editFor(r).dial}
                    onChange={(e) => setEdit(r, { dial: e.target.value })}
                    onBlur={() => saveGoals(r)}
                  />
                  dials
                </span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }} title="Stretch tier — leave blank for 1.5× the dial goal">
                  <input
                    className="vmsel"
                    style={goalInput}
                    type="number"
                    min={1}
                    placeholder={String(Math.round((Number(editFor(r).dial) || r.daily_dial_goal) * 1.5 / 5) * 5)}
                    value={editFor(r).bonus}
                    onChange={(e) => setEdit(r, { bonus: e.target.value })}
                    onBlur={() => saveGoals(r)}
                  />
                  bonus
                </span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="vmsel"
                    style={goalInput}
                    type="number"
                    min={1}
                    value={editFor(r).talk}
                    onChange={(e) => setEdit(r, { talk: e.target.value })}
                    onBlur={() => saveGoals(r)}
                  />
                  min talk
                </span>
              </span>
            </div>
          ))}
      </div>

      <Link href="/settings/archetypes" className="card" style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18, textDecoration: "none", color: "inherit" }}>
        <span style={{ fontSize: 22 }}>🧠</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Archetype Mapping</div>
          <div className="viewsub" style={{ margin: 0 }}>Personas + universal attributes the AI deal-profiler classifies against.</div>
        </div>
        <span style={{ color: "var(--text-3)" }}>→</span>
      </Link>

      <CommLibraryAdmin />
      <DealSourcesAdmin />
      <PipelineAdmin />
      <SprintListConfigAdmin />
      <ReassignAdmin />
      <IntakeAdmin />
    </>
  );
}

// ── Auto-reassignment: quiet deals flow back to the reprospecting pool ─────

function ReassignAdmin() {
  const [cfg, setCfg] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ matched: number; capped: boolean; sample: any[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    fetch("/api/crm/reassign")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setCfg(d.config))
      .catch(() => {});
  }, []);

  if (!cfg) return null;

  async function save() {
    setSaving(true);
    setMsg(null);
    const r = await fetch("/api/crm/reassign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    });
    setSaving(false);
    setMsg(r.ok ? "✓ Saved" : "⚠ Save failed");
  }

  async function runPreview() {
    setPreviewing(true);
    setPreview(null);
    // Save first so the preview reflects what's on screen.
    await fetch("/api/crm/reassign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const r = await fetch("/api/crm/reassign?preview=1");
    setPreviewing(false);
    if (r.ok) {
      const d = await r.json();
      setPreview({ matched: d.matched, capped: d.capped, sample: d.sample ?? [] });
    } else setMsg("⚠ Preview failed");
  }

  const numField = (label: string, key: string) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5, color: "var(--text-3)" }}>
      {label}
      <input
        className="vmsel"
        style={{ width: 110 }}
        type="number"
        value={cfg[key] ?? ""}
        onChange={(e) => setCfg((c: any) => ({ ...c, [key]: e.target.value === "" ? null : Number(e.target.value) }))}
      />
    </label>
  );

  return (
    <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
      <h3 style={{ margin: "0 0 4px" }}>♻️ Auto-reassignment</h3>
      <p className="viewsub" style={{ marginTop: 0 }}>
        Open deals with no rep-initiated activity for the window below (and no deposit placed) move to the
        reprospecting pool nightly. Customer engagement alone doesn&apos;t keep a deal.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setCfg((c: any) => ({ ...c, enabled: e.target.checked }))} />
        Enabled (runs nightly)
      </label>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        {numField("Inactive after (days)", "inactive_days")}
        {numField("Max reassigned per night", "max_per_run")}
        {numField("Pool owner (Pipedrive ID)", "target_owner_pipedrive_id")}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={!!cfg.exempt_future_scheduled}
          onChange={(e) => setCfg((c: any) => ({ ...c, exempt_future_scheduled: e.target.checked }))}
        />
        Skip deals with a future activity scheduled
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button className="btn" onClick={runPreview} disabled={previewing}>{previewing ? "Checking…" : "Preview matches"}</button>
        {msg && <span style={{ fontSize: 13, color: msg.startsWith("✓") ? "var(--good)" : "var(--bad)" }}>{msg}</span>}
      </div>

      {preview && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <div style={{ fontWeight: 650 }}>
            {preview.matched.toLocaleString()} deal{preview.matched === 1 ? "" : "s"} would move tonight
            {preview.capped ? " (capped — remainder sweeps on following nights)" : ""}
          </div>
          {preview.sample.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--text-3)" }}>
              {preview.sample.map((s) => (
                <li key={s.dealId}>
                  <a href={`/crm/deal/${s.dealId}`} style={{ color: "var(--text-2)" }}>{s.title}</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Intake Engine: Zapier-replacement funnels, fully config-driven ─────────

function IntakeAdmin() {
  const [data, setData] = useState<{ sources: any[]; reps: { name: string; pipedrive_user_id: number }[]; counts: Record<string, Record<string, number>> } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/intake")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data || data.sources.length === 0) return null;

  async function save(id: string, patch: Record<string, unknown>) {
    const r = await fetch("/api/admin/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    setMsg(r.ok ? "✓ Saved" : "⚠ Save failed");
    load();
  }

  return (
    <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
      <h3 style={{ margin: "0 0 4px" }}>🔀 Intake engines</h3>
      <p className="viewsub" style={{ marginTop: 0 }}>
        Deal-injection funnels (Zapier replacements). Toggle an engine on once its Zap is retired; per-engine
        round-robin pools control who receives the leads.
      </p>
      {data.sources.map((s) => {
        const cfg = s.config ?? {};
        const pool: { pipedrive_id: number; name?: string; enabled: boolean }[] = cfg.owner_pool ?? [];
        const c = data.counts[s.id] ?? {};
        const setCfg = (k: string, v: unknown) => save(s.id, { config: { ...cfg, [k]: v } });
        return (
          <div key={s.id} style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <b style={{ fontSize: 14.5 }}>{s.label}</b>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>{s.adapter}{s.channel_id ? ` · ch ${s.channel_id}` : ""}</span>
              <span style={{ fontSize: 12, color: "var(--text-3)", marginLeft: "auto" }}>
                7d: {["created", "noted", "reopened", "skipped", "error"].filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(" · ") || "no activity"}
              </span>
              <button
                className="btn ghost"
                style={{ padding: "5px 12px", fontSize: 13, color: cfg.write_pipedrive !== false ? undefined : "var(--warn)" }}
                title="App is always written first. This controls whether the engine ALSO writes to Pipedrive — turn off at cutover."
                onClick={() => save(s.id, { config: { ...cfg, write_pipedrive: cfg.write_pipedrive === false } })}
              >
                {cfg.write_pipedrive !== false ? "→ Pipedrive: on" : "→ Pipedrive: OFF"}
              </button>
              <button
                className={`btn ${s.enabled ? "primary" : "ghost"}`}
                style={{ padding: "5px 12px", fontSize: 13 }}
                onClick={() => save(s.id, { enabled: !s.enabled })}
              >
                {s.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
              {s.adapter === "typeform" && (
                <label style={{ fontSize: 12.5, color: "var(--text-3)" }} title="Exact Typeform title (id caches automatically on first submission)">
                  Typeform name
                  <input className="vmsel" style={{ width: 220, display: "block", marginTop: 3 }} defaultValue={cfg.typeform_form_name ?? ""} onBlur={(e) => e.target.value !== (cfg.typeform_form_name ?? "") && setCfg("typeform_form_name", e.target.value.trim())} />
                </label>
              )}
              {s.adapter === "klaviyo_metric" && (
                <label style={{ fontSize: 12.5, color: "var(--text-3)" }} title="Watched Klaviyo metric (id resolves automatically)">
                  Klaviyo metric
                  <input className="vmsel" style={{ width: 200, display: "block", marginTop: 3 }} defaultValue={cfg.klaviyo_metric_name ?? ""} onBlur={(e) => e.target.value !== (cfg.klaviyo_metric_name ?? "") && setCfg("klaviyo_metric_name", e.target.value.trim())} />
                </label>
              )}
              {s.adapter === "klaviyo_list" && (
                <label style={{ fontSize: 12.5, color: "var(--text-3)" }} title="Watched Klaviyo list (id resolves automatically)">
                  Klaviyo list
                  <input className="vmsel" style={{ width: 180, display: "block", marginTop: 3 }} defaultValue={cfg.klaviyo_list_name ?? ""} onBlur={(e) => e.target.value !== (cfg.klaviyo_list_name ?? "") && setCfg("klaviyo_list_name", e.target.value.trim())} />
                </label>
              )}
              {s.adapter === "klaviyo_segment" && (
                <label style={{ fontSize: 12.5, color: "var(--text-3)" }} title="Watched Klaviyo segment (id resolves automatically)">
                  Klaviyo segment
                  <input className="vmsel" style={{ width: 220, display: "block", marginTop: 3 }} defaultValue={cfg.klaviyo_segment_name ?? ""} onBlur={(e) => e.target.value !== (cfg.klaviyo_segment_name ?? "") && setCfg("klaviyo_segment_name", e.target.value.trim())} />
                </label>
              )}
              {s.adapter === "shopify_abandoned_checkout" && (
                <>
                  <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                    SKU filter
                    <input className="vmsel" style={{ width: 110, display: "block", marginTop: 3 }} defaultValue={cfg.sku_contains ?? ""} onBlur={(e) => e.target.value !== (cfg.sku_contains ?? "") && setCfg("sku_contains", e.target.value.trim())} />
                  </label>
                  <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                    Settle delay (min)
                    <input className="vmsel" style={{ width: 90, display: "block", marginTop: 3 }} type="number" defaultValue={cfg.delay_minutes ?? 60} onBlur={(e) => setCfg("delay_minutes", Number(e.target.value) || 60)} />
                  </label>
                </>
              )}
              <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                Title template
                <input className="vmsel" style={{ width: 220, display: "block", marginTop: 3 }} defaultValue={cfg.title_template ?? ""} onBlur={(e) => e.target.value !== (cfg.title_template ?? "") && setCfg("title_template", e.target.value)} />
              </label>
              <label style={{ fontSize: 12.5, color: "var(--text-3)" }} title="Appended to engine-created deal titles so they're distinguishable from Zapier's during parallel running. Clear to turn off.">
                Engine marker
                <input className="vmsel" style={{ width: 70, display: "block", marginTop: 3 }} defaultValue={cfg.title_marker ?? ""} onBlur={(e) => e.target.value !== (cfg.title_marker ?? "") && setCfg("title_marker", e.target.value.trim())} />
              </label>
              <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                Existing open deal
                <select className="vmsel" style={{ display: "block", marginTop: 3 }} value={cfg.on_existing_open ?? "note"} onChange={(e) => setCfg("on_existing_open", e.target.value)}>
                  <option value="note">Add note (re-heat)</option>
                  <option value="new_deal">Create new deal</option>
                  <option value="skip">Skip</option>
                </select>
              </label>
              <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                Existing closed deal
                <select className="vmsel" style={{ display: "block", marginTop: 3 }} value={cfg.on_existing_closed ?? "reopen_assign"} onChange={(e) => setCfg("on_existing_closed", e.target.value)}>
                  <option value="reopen_assign">Note + reopen + assign</option>
                  <option value="new_deal">Create new deal</option>
                  <option value="skip">Skip</option>
                </select>
              </label>
            </div>
            <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-3)" }}>
              <label style={{ marginRight: 18 }} title="Notify the deal owner (bell) on new deals, notes, and reopens from this engine">
                <input type="checkbox" checked={cfg.notify_owner === true} onChange={() => setCfg("notify_owner", cfg.notify_owner !== true)} style={{ marginRight: 4 }} />
                🔔 Notify owner
              </label>
              Round-robin pool:&nbsp;
              {data.reps.map((r) => {
                const entry = pool.find((p) => p.pipedrive_id === r.pipedrive_user_id);
                const on = entry?.enabled ?? false;
                return (
                  <label key={r.pipedrive_user_id} style={{ marginRight: 14, color: on ? "var(--text-1)" : "var(--text-3)" }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const next = pool.some((p) => p.pipedrive_id === r.pipedrive_user_id)
                          ? pool.map((p) => (p.pipedrive_id === r.pipedrive_user_id ? { ...p, enabled: !on } : p))
                          : [...pool, { pipedrive_id: r.pipedrive_user_id, name: r.name, enabled: true }];
                        setCfg("owner_pool", next);
                      }}
                      style={{ marginRight: 4 }}
                    />
                    {r.name.split(" ")[0]}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      {msg && <div className="viewsub" style={{ marginTop: 8, color: msg.startsWith("✓") ? "var(--good)" : "var(--bad)" }}>{msg}</div>}
    </div>
  );
}

// ── Sprint List tuning: caps, tier windows, clock, hot-signal regex ────────

function SprintListConfigAdmin() {
  const [cfg, setCfg] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/crm/sprint-lists/config")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setCfg(d.config))
      .catch(() => {});
  }, []);

  if (!cfg) return null;

  const num = (path: string[], v: string) => {
    setCfg((c: any) => {
      const next = structuredClone(c);
      let o = next;
      for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
      o[path[path.length - 1]] = v === "" ? null : Number(v);
      return next;
    });
  };
  const txt = (path: string[], v: string) => {
    setCfg((c: any) => {
      const next = structuredClone(c);
      let o = next;
      for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
      o[path[path.length - 1]] = v;
      return next;
    });
  };

  async function save() {
    setSaving(true);
    setMsg(null);
    const r = await fetch("/api/crm/sprint-lists/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    });
    setSaving(false);
    setMsg(r.ok ? "✓ Saved" : "⚠ Save failed");
  }

  const W = cfg.windows;
  const numField = (label: string, path: string[], val: any) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5, color: "var(--text-3)" }}>
      {label}
      <input className="vmsel" style={{ width: 90 }} type="number" value={val ?? ""} onChange={(e) => num(path, e.target.value)} />
    </label>
  );

  return (
    <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
      <h3 style={{ margin: "0 0 4px" }}>📋 Sprint List tuning</h3>
      <p className="viewsub" style={{ marginTop: 0 }}>Caps, tier windows (days), and hot-signal matching for the daily call lists.</p>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
        {numField("List cap", ["cap"], cfg.cap)}
        {numField("Reprospect sub-cap", ["reprospect_subcap"], cfg.reprospect_subcap)}
        {numField("Checkout hold (days)", ["checkout_hold_days"], cfg.checkout_hold_days)}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, margin: "6px 0" }}>Tier windows (days)</div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        {numField("Hot (1a/1b)", ["windows", "hot_days"], W.hot_days)}
        {numField("New deal", ["windows", "new_deal_days"], W.new_deal_days)}
        {numField("Marketing signal", ["windows", "marketing_signal_days"], W.marketing_signal_days)}
        {numField("Recent activity", ["windows", "recent_activity_days"], W.recent_activity_days)}
        {numField("Scheduled ahead", ["windows", "scheduled_ahead_days"], W.scheduled_ahead_days)}
        {numField("No conversation", ["windows", "no_conversation_days"], W.no_conversation_days)}
        {numField("Stale min", ["windows", "stale_min_days"], W.stale_min_days)}
        {numField("Stale max", ["windows", "stale_max_days"], W.stale_max_days)}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, margin: "6px 0" }}>Hot-signal matching (regex on engagement_events.type)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
          1a — buy intent
          <input className="vmsel" style={{ width: "100%", marginTop: 3 }} value={cfg.hot_1a_regex} onChange={(e) => txt(["hot_1a_regex"], e.target.value)} />
        </label>
        <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
          1b — active engagement (excludes email_open)
          <input className="vmsel" style={{ width: "100%", marginTop: 3 }} value={cfg.hot_1b_regex} onChange={(e) => txt(["hot_1b_regex"], e.target.value)} />
        </label>
      </div>

      <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      {msg && <span style={{ marginLeft: 10, fontSize: 13, color: msg.startsWith("✓") ? "var(--good)" : "var(--bad)" }}>{msg}</span>}
    </div>
  );
}

// ── Outreach library: macros + assets (deal-page comm bar) ─────────────────

interface Macro {
  id: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
}
interface Asset {
  id: string;
  kind: string;
  name: string;
  url: string;
}

const CHANNELS = [
  ["any", "Any channel"],
  ["sms", "💬 Text"],
  ["whatsapp", "🟢 WhatsApp"],
  ["email", "✉️ Email"],
] as const;

function CommLibraryAdmin() {
  const [macros, setMacros] = useState<Macro[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // Macro editor (blank id = new)
  const [editing, setEditing] = useState<Partial<Macro> | null>(null);
  // Asset add form
  const [aKind, setAKind] = useState("url");
  const [aName, setAName] = useState("");
  const [aUrl, setAUrl] = useState("");

  const load = useCallback(
    () =>
      fetch("/api/crm/comm-library")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          setMacros(d.macros ?? []);
          setAssets(d.assets ?? []);
        }),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    const r = await fetch("/api/crm/comm-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    setMsg(r?.ok ? "✓ Saved" : d?.error ?? "Save failed");
    setTimeout(() => setMsg(null), 2500);
    await load();
    return Boolean(r?.ok);
  };

  const saveMacro = async () => {
    if (!editing?.name?.trim() || !editing.body?.trim()) return;
    const ok = await post({
      op: "macro",
      macro: {
        id: editing.id,
        channel: editing.channel ?? "any",
        name: editing.name,
        subject: editing.subject ?? null,
        body: editing.body,
      },
    });
    if (ok) setEditing(null);
  };

  const chLabel = (c: string) => CHANNELS.find(([k]) => k === c)?.[1] ?? c;

  return (
    <>
      <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
        <div className="panel-h">Message macros</div>
        <div style={{ fontSize: 13.5, color: "var(--text-3)", marginBottom: 10 }}>
          Templates for the deal-page Text / WhatsApp / Email composers.
          Placeholders: <code>{"{{first_name}}"}</code> and <code>{"{{name}}"}</code>.
          {msg && <b style={{ marginLeft: 8, color: "var(--text-2)" }}>{msg}</b>}
        </div>
        {macros.map((m) => (
          <div className="stmt-row" key={m.id} style={{ alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 14 }}>{m.name}</b>
              <span className="chip stage" style={{ marginLeft: 8 }}>{chLabel(m.channel)}</span>
              <div style={{ fontSize: 12.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.body}
              </div>
            </div>
            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setEditing({ ...m })}>
                ✏️
              </button>
              <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => post({ op: "macro_delete", id: m.id })}>
                🗑
              </button>
            </span>
          </div>
        ))}
        {!editing && (
          <button className="btn ghost" style={{ marginTop: 10, padding: "6px 14px", fontSize: 13.5 }} onClick={() => setEditing({ channel: "any" })}>
            ＋ New macro
          </button>
        )}
        {editing && (
          <div style={{ marginTop: 12, display: "grid", gap: 8, background: "var(--surface-2)", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                className="vmsel"
                style={{ width: "auto" }}
                value={editing.channel ?? "any"}
                onChange={(e) => setEditing((m) => ({ ...m, channel: e.target.value }))}
              >
                {CHANNELS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <input
                className="vmsel"
                style={{ flex: 1, minWidth: 160 }}
                placeholder="Macro name (e.g. First follow-up)"
                value={editing.name ?? ""}
                onChange={(e) => setEditing((m) => ({ ...m, name: e.target.value }))}
              />
            </div>
            {editing.channel === "email" && (
              <input
                className="vmsel"
                placeholder="Email subject…"
                value={editing.subject ?? ""}
                onChange={(e) => setEditing((m) => ({ ...m, subject: e.target.value }))}
              />
            )}
            <textarea
              className="vmsel"
              rows={4}
              style={{ resize: "vertical" }}
              placeholder="Message body… ({{first_name}} inserts the contact's first name)"
              value={editing.body ?? ""}
              onChange={(e) => setEditing((m) => ({ ...m, body: e.target.value }))}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" disabled={!editing.name?.trim() || !editing.body?.trim()} onClick={saveMacro}>
                {editing.id ? "Save changes" : "Create macro"}
              </button>
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
        <div className="panel-h">Asset library</div>
        <div style={{ fontSize: 13.5, color: "var(--text-3)", marginBottom: 10 }}>
          URLs (build pages, booking links) and media (hosted images/videos) the composers can drop into a message.
        </div>
        {assets.map((a) => (
          <div className="stmt-row" key={a.id} style={{ alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 14 }}>{a.kind === "media" ? "🖼" : "🔗"} {a.name}</b>
              <div style={{ fontSize: 12.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.url}
              </div>
            </div>
            <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5, flexShrink: 0 }} onClick={() => post({ op: "asset_delete", id: a.id })}>
              🗑
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <select className="vmsel" style={{ width: "auto" }} value={aKind} onChange={(e) => setAKind(e.target.value)}>
            <option value="url">🔗 URL</option>
            <option value="media">🖼 Media</option>
          </select>
          <input className="vmsel" style={{ flex: 1, minWidth: 120 }} placeholder="Name" value={aName} onChange={(e) => setAName(e.target.value)} />
          <input className="vmsel" style={{ flex: 2, minWidth: 180 }} placeholder="https://…" value={aUrl} onChange={(e) => setAUrl(e.target.value)} />
          <button
            className="btn primary"
            style={{ padding: "8px 14px", fontSize: 13.5 }}
            disabled={!aName.trim() || !aUrl.trim()}
            onClick={async () => {
              const ok = await post({ op: "asset", asset: { kind: aKind, name: aName, url: aUrl } });
              if (ok) {
                setAName("");
                setAUrl("");
              }
            }}
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}

// ── Deal sources (Pipedrive channel-mapped + native) ───────────────────────

interface DealSource {
  id: string;
  name: string;
  pipedrive_channel_id: number | null;
}

function DealSourcesAdmin() {
  const [sources, setSources] = useState<DealSource[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/crm/sources")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSources(d.sources ?? [])),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    const r = await fetch("/api/crm/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    setMsg(r?.ok ? "✓ Saved" : d?.error ?? "Save failed");
    setTimeout(() => setMsg(null), 2500);
    await load();
    return Boolean(r?.ok);
  };

  return (
    <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
      <div className="panel-h">Deal sources</div>
      <div style={{ fontSize: 13.5, color: "var(--text-3)", marginBottom: 10 }}>
        Where deals come from. Sources tagged <b>PD</b> map directly to Pipedrive channels
        (mirrored deals pick them up automatically); the rest are native — assign them on the
        deal page. {msg && <b style={{ color: "var(--text-2)" }}>{msg}</b>}
      </div>
      {sources.map((s) => (
        <div className="stmt-row" key={s.id} style={{ alignItems: "center", gap: 8 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
            <input
              className="vmsel"
              style={{ flex: 1 }}
              value={edits[s.id] ?? s.name}
              onChange={(e) => setEdits((m) => ({ ...m, [s.id]: e.target.value }))}
              onBlur={() => {
                const v = (edits[s.id] ?? s.name).trim();
                if (v && v !== s.name) void post({ op: "save", source: { id: s.id, name: v } });
              }}
            />
            {s.pipedrive_channel_id != null && (
              <span className="chip stage" title="Mapped to a Pipedrive channel">PD #{s.pipedrive_channel_id}</span>
            )}
          </span>
          <button
            className="btn ghost"
            style={{ padding: "4px 10px", fontSize: 12.5, flexShrink: 0 }}
            title="Delete (deals fall back to no source)"
            onClick={() => post({ op: "delete", id: s.id })}
          >
            🗑
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          className="vmsel"
          style={{ flex: 1 }}
          placeholder="New source name… (e.g. Referral, Walk-in, Instagram DM)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newName.trim() && post({ op: "save", source: { name: newName.trim() } }).then((ok) => ok && setNewName(""))}
        />
        <button
          className="btn primary"
          style={{ padding: "8px 14px", fontSize: 13.5 }}
          disabled={!newName.trim()}
          onClick={() => post({ op: "save", source: { name: newName.trim() } }).then((ok) => ok && setNewName(""))}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ── Pipelines & stages editor (prefilled from Pipedrive, editable in-app) ──

interface PLStage {
  id: string;
  name: string;
  pipeline_id: string;
  sort_order: number;
  dealCount: number;
}
interface PLPipeline {
  id: string;
  name: string;
  sort_order: number;
  stages: PLStage[];
}

function PipelineAdmin() {
  const [pipelines, setPipelines] = useState<PLPipeline[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [newPipeline, setNewPipeline] = useState("");
  const [newStage, setNewStage] = useState<Record<string, string>>({}); // pipelineId → name
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({}); // id → name buffer

  const load = useCallback(
    () =>
      fetch("/api/crm/pipelines")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setPipelines(d.pipelines ?? [])),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    const r = await fetch("/api/crm/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    setMsg(r?.ok ? "✓ Saved" : d?.error ?? "Save failed");
    setTimeout(() => setMsg(null), 3000);
    await load();
    return Boolean(r?.ok);
  };

  const nameFor = (id: string, current: string) => nameEdits[id] ?? current;

  return (
    <div className="card" style={{ maxWidth: 680, marginTop: 18 }}>
      <div className="panel-h">Pipelines &amp; stages</div>
      <div style={{ fontSize: 13.5, color: "var(--text-3)", marginBottom: 12 }}>
        Prefilled from Pipedrive; edits here stay in the app (not written back).
        Deleting is blocked while deals still occupy a stage or pipeline.
        {msg && <b style={{ marginLeft: 8, color: "var(--text-2)" }}>{msg}</b>}
      </div>

      {pipelines.map((p) => (
        <div key={p.id} style={{ border: "1px solid var(--border-soft)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              className="vmsel"
              style={{ flex: 1, fontWeight: 700 }}
              value={nameFor(p.id, p.name)}
              onChange={(e) => setNameEdits((m) => ({ ...m, [p.id]: e.target.value }))}
              onBlur={() => {
                const v = nameFor(p.id, p.name).trim();
                if (v && v !== p.name) void post({ op: "pipeline_save", id: p.id, name: v });
              }}
            />
            <button
              className="btn ghost"
              style={{ padding: "6px 11px", fontSize: 12.5 }}
              title="Delete pipeline"
              onClick={() => post({ op: "pipeline_delete", id: p.id })}
            >
              🗑
            </button>
          </div>
          {p.stages.map((s, i) => (
            <div key={s.id} className="stmt-row" style={{ alignItems: "center", gap: 6, padding: "6px 0" }}>
              <input
                className="vmsel"
                style={{ flex: 1 }}
                value={nameFor(s.id, s.name)}
                onChange={(e) => setNameEdits((m) => ({ ...m, [s.id]: e.target.value }))}
                onBlur={() => {
                  const v = nameFor(s.id, s.name).trim();
                  if (v && v !== s.name) void post({ op: "stage_save", id: s.id, name: v });
                }}
              />
              <span style={{ fontSize: 12, color: "var(--text-3)", width: 62, textAlign: "right", flexShrink: 0 }}>
                {s.dealCount} deal{s.dealCount === 1 ? "" : "s"}
              </span>
              <button className="btn ghost" style={{ padding: "3px 8px", fontSize: 12 }} disabled={i === 0} title="Move up" onClick={() => post({ op: "stage_reorder", id: s.id, dir: "up" })}>▲</button>
              <button className="btn ghost" style={{ padding: "3px 8px", fontSize: 12 }} disabled={i === p.stages.length - 1} title="Move down" onClick={() => post({ op: "stage_reorder", id: s.id, dir: "down" })}>▼</button>
              <button className="btn ghost" style={{ padding: "3px 8px", fontSize: 12 }} title="Delete stage" onClick={() => post({ op: "stage_delete", id: s.id })}>🗑</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              className="vmsel"
              style={{ flex: 1 }}
              placeholder="Add a stage…"
              value={newStage[p.id] ?? ""}
              onChange={(e) => setNewStage((m) => ({ ...m, [p.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (newStage[p.id] ?? "").trim()) {
                  void post({ op: "stage_save", pipelineId: p.id, name: newStage[p.id].trim() }).then((ok) => ok && setNewStage((m) => ({ ...m, [p.id]: "" })));
                }
              }}
            />
            <button
              className="btn"
              style={{ padding: "7px 12px", fontSize: 13 }}
              disabled={!(newStage[p.id] ?? "").trim()}
              onClick={() => post({ op: "stage_save", pipelineId: p.id, name: newStage[p.id].trim() }).then((ok) => ok && setNewStage((m) => ({ ...m, [p.id]: "" })))}
            >
              + Stage
            </button>
          </div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <input
          className="vmsel"
          style={{ flex: 1 }}
          placeholder="New pipeline name…"
          value={newPipeline}
          onChange={(e) => setNewPipeline(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newPipeline.trim() && post({ op: "pipeline_save", name: newPipeline.trim() }).then((ok) => ok && setNewPipeline(""))}
        />
        <button
          className="btn primary"
          style={{ padding: "8px 14px", fontSize: 13.5 }}
          disabled={!newPipeline.trim()}
          onClick={() => post({ op: "pipeline_save", name: newPipeline.trim() }).then((ok) => ok && setNewPipeline(""))}
        >
          Add pipeline
        </button>
      </div>
    </div>
  );
}
