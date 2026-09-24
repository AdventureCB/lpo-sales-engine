"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PLACEHOLDERS } from "@/lib/placeholders";

interface Step {
  id?: string; delay_hours: number; content_kind: "inline" | "macro" | "prompt"; macro_id: string | null;
  subject: string; body: string; prompt: string; steering: string; conditions: { skip_if_opened_prev?: boolean; only_if_opened_prev?: boolean };
}
interface Campaign {
  id?: string; name: string; channel: "email" | "sms"; mode: "macro" | "ai"; status: string; shared: boolean; owner_email?: string | null;
  trigger: { type: "manual" | "state"; source?: string | null; min_attempts?: number | null; max_contacts?: number | null; min_days_since_created?: number | null; min_days_since_activity?: number | null; pipeline?: string | null };
  settings: { window_start?: number; window_end?: number; exit_on_reply?: boolean; stop_on_other_rep?: boolean; reenroll_after_days?: number };
  campaign_steps?: Step[];
  stats?: { active: number; completed: number; exited: number };
}

const blankStep = (): Step => ({ delay_hours: 48, content_kind: "inline", macro_id: null, subject: "", body: "", prompt: "", steering: "", conditions: {} });
const blankCampaign = (): Campaign => ({ name: "", channel: "email", mode: "macro", status: "draft", shared: true, trigger: { type: "manual" }, settings: { window_start: 9, window_end: 17, exit_on_reply: true, stop_on_other_rep: true }, campaign_steps: [blankStep()] });
const delayLabel = (h: number) => (h === 0 ? "immediately" : h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h}h`);

/**
 * 📣 Campaigns — build drip sequences. Macro mode = written steps (any rep);
 * AI mode = per-step prompts (admin only; generation lands in Phase 2).
 * Trigger: manual (enroll from CRM / sprint lists / deal page) or a state
 * rule that auto-enrolls matching open deals every 15 minutes.
 */
export function CampaignsView() {
  const [data, setData] = useState<{ isAdmin: boolean; me: string; campaigns: Campaign[]; macros: { id: string; name: string; subject: string | null }[]; sources: string[]; pipelines: string[] } | null>(null);
  const [edit, setEdit] = useState<Campaign | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch("/api/campaigns").then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setData).catch((e) => setMsg(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (c: Campaign, statusOverride?: string) => {
    setSaving(true);
    const r = await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...c, status: statusOverride ?? c.status, steps: c.campaign_steps ?? [] }) });
    const j = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok || j.error) { setMsg(`⚠ ${j.error ?? `HTTP ${r.status}`}`); return; }
    setMsg("Saved ✓");
    setTimeout(() => setMsg(null), 3000);
    setEdit(null);
    load();
  };
  const archive = async (c: Campaign) => {
    if (!confirm(`Archive "${c.name}"? Active enrollments will end.`)) return;
    await fetch(`/api/campaigns?id=${c.id}`, { method: "DELETE" });
    load();
  };

  if (!data) return <p className="viewsub">{msg ?? "Loading…"}</p>;

  if (edit) {
    const c = edit;
    const set = (patch: Partial<Campaign>) => setEdit({ ...c, ...patch });
    const steps = c.campaign_steps ?? [];
    const setStep = (i: number, patch: Partial<Step>) => set({ campaign_steps: steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
    const move = (i: number, dir: -1 | 1) => { const n = [...steps]; const j = i + dir; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; set({ campaign_steps: n }); };
    const canAi = data.isAdmin;
    return (
      <div>
        <div className="viewhead" style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <h1>📣 {c.id ? "Edit campaign" : "New campaign"}</h1>
          {msg && <span style={{ fontSize: 13, color: msg.startsWith("⚠") ? "var(--crit)" : "var(--good)" }}>{msg}</span>}
        </div>
        <div className="card" style={{ maxWidth: 820, marginBottom: 14 }}>
          <div className="panel-h">Basics</div>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "2fr 1fr 1fr" }}>
            <div className="field"><label>Name</label><input className="vmsel" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Saved build, no contact" /></div>
            <div className="field"><label>Mode</label>
              <select className="vmsel" value={c.mode} onChange={(e) => set({ mode: e.target.value as any })}>
                <option value="macro">Written steps</option>
                {canAi && <option value="ai">AI prompts (admin)</option>}
              </select>
            </div>
            <div className="field"><label>Channel</label>
              <select className="vmsel" value={c.channel} onChange={(e) => set({ channel: e.target.value as any })}>
                <option value="email">Email</option>
                <option value="sms" disabled>Text (Phase 4)</option>
              </select>
            </div>
          </div>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13.5, marginTop: 8 }}>
            <input type="checkbox" checked={c.shared} onChange={(e) => set({ shared: e.target.checked })} /> Shared with the whole team (they can enroll deals into it)
          </label>
        </div>

        <div className="card" style={{ maxWidth: 820, marginBottom: 14 }}>
          <div className="panel-h">Who gets enrolled</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            {[["manual", "Manually (CRM / sprint list / deal page)"], ["state", "Automatically when a deal matches"]].map(([v, l]) => (
              <button key={v} className={`btn ${c.trigger.type === v ? "primary" : "ghost"}`} style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => set({ trigger: { ...c.trigger, type: v as any } })}>{l}</button>
            ))}
          </div>
          {c.trigger.type === "state" && (
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
              <div className="field"><label>Deal source</label>
                <select className="vmsel" value={c.trigger.source ?? ""} onChange={(e) => set({ trigger: { ...c.trigger, source: e.target.value || null } })}>
                  <option value="">Any source</option>
                  {data.sources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="field"><label>Pipeline</label>
                <select className="vmsel" value={c.trigger.pipeline ?? ""} onChange={(e) => set({ trigger: { ...c.trigger, pipeline: e.target.value || null } })}>
                  <option value="">Any pipeline</option>
                  {data.pipelines.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="field"><label>Min call attempts</label><input className="vmsel" type="number" min={0} value={c.trigger.min_attempts ?? ""} onChange={(e) => set({ trigger: { ...c.trigger, min_attempts: e.target.value === "" ? null : Number(e.target.value) } })} placeholder="any" /></div>
              <div className="field"><label>Max conversations</label><input className="vmsel" type="number" min={0} value={c.trigger.max_contacts ?? ""} onChange={(e) => set({ trigger: { ...c.trigger, max_contacts: e.target.value === "" ? null : Number(e.target.value) } })} placeholder="any" /></div>
              <div className="field"><label>Deal at least (days old)</label><input className="vmsel" type="number" min={0} value={c.trigger.min_days_since_created ?? ""} onChange={(e) => set({ trigger: { ...c.trigger, min_days_since_created: e.target.value === "" ? null : Number(e.target.value) } })} placeholder="any" /></div>
              <div className="field"><label>Quiet for (days, no activity)</label><input className="vmsel" type="number" min={0} value={c.trigger.min_days_since_activity ?? ""} onChange={(e) => set({ trigger: { ...c.trigger, min_days_since_activity: e.target.value === "" ? null : Number(e.target.value) } })} placeholder="any" /></div>
            </div>
          )}
          <div className="viewsub" style={{ fontSize: 12.5 }}>
            Always enforced: open deals only · has an email · owner has Gmail connected · not DNC / opted out · one active email campaign per deal · no re-entry within {c.settings.reenroll_after_days ?? 60} days.
          </div>
        </div>

        <div className="card" style={{ maxWidth: 820, marginBottom: 14 }}>
          <div className="panel-h">Rules</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="field"><label>Send window (customer local)</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input className="vmsel" type="number" min={0} max={23} style={{ width: 70 }} value={c.settings.window_start ?? 9} onChange={(e) => set({ settings: { ...c.settings, window_start: Number(e.target.value) } })} />
                <span>to</span>
                <input className="vmsel" type="number" min={1} max={24} style={{ width: 70 }} value={c.settings.window_end ?? 17} onChange={(e) => set({ settings: { ...c.settings, window_end: Number(e.target.value) } })} />
                <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>o'clock</span>
              </div>
            </div>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13.5 }}><input type="checkbox" checked={c.settings.exit_on_reply ?? true} onChange={(e) => set({ settings: { ...c.settings, exit_on_reply: e.target.checked } })} /> Stop when the customer replies</label>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13.5 }}><input type="checkbox" checked={c.settings.stop_on_other_rep ?? true} onChange={(e) => set({ settings: { ...c.settings, stop_on_other_rep: e.target.checked } })} /> Stop if another rep contacts them</label>
          </div>
          <div className="viewsub" style={{ fontSize: 12.5 }}>Fixed for every campaign: max 2 emails per contact per week · the owner's own manual email or text delays the next step by 24h · a Klaviyo-heavy day (2+ opens) delays it 12h · every send waits for approval in the Outbox.</div>
        </div>

        <div className="card" style={{ maxWidth: 820, marginBottom: 14 }}>
          <div className="panel-h">Steps</div>
          {steps.map((s, i) => (
            <div key={i} style={{ borderTop: i ? "1px solid var(--border-soft)" : undefined, paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <b>Step {i + 1}</b>
                <span style={{ fontSize: 13, color: "var(--text-3)" }}>send</span>
                <input className="vmsel" type="number" min={0} step={1} style={{ width: 70 }} value={Math.round(s.delay_hours / 24 * 10) / 10} onChange={(e) => setStep(i, { delay_hours: Math.round(Number(e.target.value) * 24) })} />
                <span style={{ fontSize: 13, color: "var(--text-3)" }}>days after {i === 0 ? "enrollment" : `step ${i}`} ({delayLabel(s.delay_hours)})</span>
                <select className="vmsel" style={{ width: "auto" }} value={s.content_kind} onChange={(e) => setStep(i, { content_kind: e.target.value as any })}>
                  <option value="inline">Write it here</option>
                  <option value="macro">Use a macro</option>
                  {canAi && c.mode === "ai" && <option value="prompt">AI prompt</option>}
                </select>
                <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                  <button className="btn ghost" style={{ padding: "2px 8px" }} onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                  <button className="btn ghost" style={{ padding: "2px 8px" }} onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
                  <button className="btn ghost" style={{ padding: "2px 8px", color: "var(--crit)" }} onClick={() => set({ campaign_steps: steps.filter((_, j) => j !== i) })}>✕</button>
                </span>
              </div>
              {s.content_kind === "inline" && (
                <div style={{ display: "grid", gap: 6 }}>
                  <input className="vmsel" style={{ width: "100%" }} placeholder="Subject" value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} />
                  <textarea className="vmsel" style={{ width: "100%", minHeight: 140, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }} placeholder="Write the email as the rep would…" value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>Placeholders: {PLACEHOLDERS.map((p) => <code key={p.token} style={{ marginRight: 6 }}>{p.token}</code>)}</div>
                </div>
              )}
              {s.content_kind === "macro" && (
                <select className="vmsel" style={{ width: "100%" }} value={s.macro_id ?? ""} onChange={(e) => setStep(i, { macro_id: e.target.value || null })}>
                  <option value="">Pick an email macro…</option>
                  {data.macros.map((m) => <option key={m.id} value={m.id}>{m.name}{m.subject ? ` — ${m.subject}` : ""}</option>)}
                </select>
              )}
              {s.content_kind === "prompt" && (
                <div style={{ display: "grid", gap: 6 }}>
                  <textarea className="vmsel" style={{ width: "100%", minHeight: 90, resize: "vertical", fontFamily: "inherit" }} placeholder="What this email should accomplish, roughly — the AI writes it per deal from everything it knows about them." value={s.prompt} onChange={(e) => setStep(i, { prompt: e.target.value })} />
                  <input className="vmsel" style={{ width: "100%" }} placeholder="Steering (optional): tone, length, must-mention, never-say…" value={s.steering} onChange={(e) => setStep(i, { steering: e.target.value })} />
                  <div style={{ fontSize: 12, color: "var(--warn, #d99a2b)" }}>AI drafting ships in Phase 2 — until then this step waits and shows "AI drafting not enabled yet" in the Outbox.</div>
                </div>
              )}
              {i > 0 && (
                <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 12.5 }}>
                  <label style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={!!s.conditions.skip_if_opened_prev} onChange={(e) => setStep(i, { conditions: { ...s.conditions, skip_if_opened_prev: e.target.checked || undefined, only_if_opened_prev: e.target.checked ? undefined : s.conditions.only_if_opened_prev } })} /> Skip if they opened step {i}</label>
                  <label style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={!!s.conditions.only_if_opened_prev} onChange={(e) => setStep(i, { conditions: { ...s.conditions, only_if_opened_prev: e.target.checked || undefined, skip_if_opened_prev: e.target.checked ? undefined : s.conditions.skip_if_opened_prev } })} /> Only if they opened step {i}</label>
                </div>
              )}
            </div>
          ))}
          <button className="btn ghost" style={{ marginTop: 12, padding: "6px 12px" }} onClick={() => set({ campaign_steps: [...steps, blankStep()] })}>+ Add step</button>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 24 }}>
          <button className="btn primary" disabled={saving || !c.name.trim()} onClick={() => save(c)}>Save{c.status === "active" ? " (stays active)" : " as draft"}</button>
          {c.status !== "active" && <button className="btn" disabled={saving || !c.name.trim() || steps.length === 0} onClick={() => save(c, "active")}>Save & activate</button>}
          {c.status === "active" && <button className="btn ghost" disabled={saving} onClick={() => save(c, "paused")}>Pause</button>}
          <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  const triggerSummary = (c: Campaign) => {
    const t = c.trigger;
    if (t.type !== "state") return "manual enrollment";
    const bits = [t.source ? `source ${t.source}` : "any source", t.pipeline ? `pipeline ${t.pipeline}` : null, t.min_attempts != null ? `≥${t.min_attempts} attempts` : null, t.max_contacts != null ? `≤${t.max_contacts} convos` : null, t.min_days_since_created != null ? `≥${t.min_days_since_created}d old` : null, t.min_days_since_activity != null ? `quiet ${t.min_days_since_activity}d` : null].filter(Boolean);
    return `auto: ${bits.join(" · ")}`;
  };

  return (
    <div>
      <div className="viewhead" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1>📣 Campaigns</h1>
        <button className="btn primary" style={{ padding: "6px 14px" }} onClick={() => setEdit(blankCampaign())}>+ New campaign</button>
        <Link href="/outbox" className="btn ghost" style={{ padding: "6px 12px", fontSize: 13 }}>📬 Outbox</Link>
        {msg && <span style={{ fontSize: 13, color: msg.startsWith("⚠") ? "var(--crit)" : "var(--good)" }}>{msg}</span>}
      </div>
      <p className="viewsub">Drip sequences sent from the deal owner's own Gmail, one approved email at a time. Written steps are open to every rep; AI-prompt campaigns are admin-built.</p>
      {data.campaigns.length === 0 && <div className="viewsub">No campaigns yet.</div>}
      {data.campaigns.map((c) => (
        <div key={c.id} className="card" style={{ padding: "12px 14px", marginBottom: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <b style={{ fontSize: 15 }}>{c.name}</b>
              <span className="chip stage" style={{ fontSize: 11.5, color: c.status === "active" ? "var(--good)" : c.status === "paused" ? "var(--warn, #d99a2b)" : "var(--text-3)" }}>{c.status}</span>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>{c.mode === "ai" ? "AI" : "written"} · {c.campaign_steps?.length ?? 0} step{(c.campaign_steps?.length ?? 0) === 1 ? "" : "s"} · {triggerSummary(c)}{c.shared ? "" : " · private"}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 2 }}>
              {c.stats?.active ?? 0} active · {c.stats?.completed ?? 0} completed · {c.stats?.exited ?? 0} exited{c.owner_email ? ` · by ${c.owner_email.split("@")[0]}` : ""}
            </div>
          </div>
          {(data.isAdmin || c.owner_email === data.me) && (
            <>
              <button className="btn ghost" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => setEdit({ ...c, campaign_steps: (c.campaign_steps ?? []).map((s) => ({ ...s, subject: s.subject ?? "", body: s.body ?? "", prompt: s.prompt ?? "", steering: s.steering ?? "", conditions: s.conditions ?? {} })) })}>Edit</button>
              {c.status === "active" ? <button className="btn ghost" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => save({ ...c, campaign_steps: c.campaign_steps }, "paused")}>Pause</button> : <button className="btn ghost" style={{ padding: "5px 12px", fontSize: 13 }} onClick={() => save({ ...c, campaign_steps: c.campaign_steps }, "active")} disabled={!(c.campaign_steps?.length)}>Activate</button>}
              <button className="btn ghost" style={{ padding: "5px 12px", fontSize: 13, color: "var(--crit)" }} onClick={() => archive(c)}>Archive</button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
