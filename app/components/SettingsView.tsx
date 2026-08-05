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
}

export function SettingsView() {
  const [reps, setReps] = useState<Rep[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // Local edit buffer so typing a goal doesn't fire a save per keystroke.
  const [goalEdits, setGoalEdits] = useState<Record<string, { dial: string; talk: string }>>({});

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
    if (dial === r.daily_dial_goal && talk === r.daily_talk_goal_min) return;
    void post({
      repId: r.id,
      ...(dial > 0 && dial !== r.daily_dial_goal ? { dialGoal: dial } : {}),
      ...(talk > 0 && talk !== r.daily_talk_goal_min ? { talkGoalMin: talk } : {}),
    });
  };

  const editFor = (r: Rep) =>
    goalEdits[r.id] ?? { dial: String(r.daily_dial_goal), talk: String(r.daily_talk_goal_min) };

  const setEdit = (r: Rep, patch: Partial<{ dial: string; talk: string }>) =>
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
    </>
  );
}
