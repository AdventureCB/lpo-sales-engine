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

      <CommLibraryAdmin />
      <DealSourcesAdmin />
    </>
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
