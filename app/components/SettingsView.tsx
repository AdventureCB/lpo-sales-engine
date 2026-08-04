"use client";

import { useCallback, useEffect, useState } from "react";

/** Admin configuration: assign each rep their own Telnyx calling number. */

interface Rep {
  id: string;
  name: string;
  quo_phone_number: string | null;
  telnyx_number: string | null;
  active?: boolean;
}

export function SettingsView() {
  const [reps, setReps] = useState<Rep[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

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

  const assign = async (repId: string, telnyxNumber: string) => {
    setMsg(null);
    const r = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repId, telnyxNumber: telnyxNumber || null }),
    }).catch(() => null);
    setMsg(r?.ok ? "✓ Saved" : "Save failed");
    await load();
  };

  const assignedElsewhere = (num: string, repId: string) =>
    reps.some((r) => r.id !== repId && r.telnyx_number === num);

  return (
    <>
      <h2 className="viewtitle">Settings</h2>
      <div className="viewsub">
        Calling configuration · browser calls use the rep’s assigned Telnyx number as caller ID
        {msg && <span style={{ marginLeft: 10, color: "var(--text-2)" }}>{msg}</span>}
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="panel-h">Rep calling numbers</div>
        {reps.map((r) => (
          <div className="stmt-row" key={r.id} style={{ alignItems: "center" }}>
            <div>
              <b style={{ fontSize: 13.5 }}>
                {r.name}
                {r.active === false && (
                  <span style={{ fontSize: 10.5, color: "var(--text-3)", fontWeight: 600 }}> · admin</span>
                )}
              </b>
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
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
          <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 8 }}>
            No Telnyx numbers on the account yet — buy numbers in the Telnyx portal (or port the Quo
            numbers at migration) and they appear here.
          </div>
        )}
      </div>
    </>
  );
}
