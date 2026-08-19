"use client";

import { useCallback, useEffect, useState } from "react";

interface AdminUser {
  authUserId: string;
  email: string;
  role: "admin" | "sales";
  repId: string | null;
  name: string | null;
  pipedriveUserId: number | null;
  telnyxNumber: string | null;
  active: boolean;
  pools: string[];
  openDeals: number;
}
interface UnlinkedRep {
  repId: string;
  name: string;
  email: string | null;
  pipedriveUserId: number | null;
  active: boolean;
}

async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => null);
  const d = await r?.json().catch(() => ({}));
  return r?.ok && !d?.error ? { ok: true } : { ok: false, error: d?.error ?? `HTTP ${r?.status ?? "?"}` };
}

/** Admin user management: add/edit/deactivate/delete team members. */
export function UsersAdmin() {
  const [data, setData] = useState<{ users: AdminUser[]; unlinkedReps: UnlinkedRep[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "sales", password: "", pipedriveUserId: "", linkRepId: "" });
  const [editing, setEditing] = useState<string | null>(null); // authUserId
  const [edit, setEdit] = useState({ name: "", role: "sales", pipedriveUserId: "", password: "" });
  const [armed, setArmed] = useState<string | null>(null); // `${op}:${authUserId}` for two-click danger ops

  const load = useCallback(() => {
    fetch("/api/admin/users")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (payload: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    const r = await post(payload);
    setBusy(false);
    setMsg(r.ok ? okMsg : `⚠ ${r.error}`);
    setArmed(null);
    if (r.ok) load();
    setTimeout(() => setMsg(null), 4000);
    return r.ok;
  };

  if (!data) return null;
  const users = [...data.users].sort((a, b) => Number(b.active) - Number(a.active) || (a.name ?? a.email).localeCompare(b.name ?? b.email));

  return (
    <div className="card" style={{ maxWidth: 780, marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h3 style={{ margin: 0 }}>👥 Users</h3>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>logins, roles, and rep records</span>
        {msg && <span style={{ fontSize: 13, color: msg.startsWith("⚠") ? "var(--crit)" : "var(--good)" }}>{msg}</span>}
        <button className="btn ghost" style={{ marginLeft: "auto", padding: "5px 12px", fontSize: 13 }} onClick={() => setAdding((v) => !v)}>
          {adding ? "✕ Cancel" : "＋ Add user"}
        </button>
      </div>
      <p className="viewsub" style={{ marginTop: 4 }}>
        New users appear everywhere automatically (owner pickers, engine pools, scoreboard, calendar). Deactivating
        bans the login, disables them in every engine round-robin, and keeps all history.
      </p>

      {adding && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--border-soft)" }}>
          <input className="vmsel" style={{ width: 150 }} placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="vmsel" style={{ width: 220 }} placeholder="email@lonepeakoverland.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select className="vmsel" style={{ width: "auto" }} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="sales">Sales</option>
            <option value="admin">Admin</option>
          </select>
          <input className="vmsel" style={{ width: 160 }} placeholder="Temp password (8+)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input
            className="vmsel"
            style={{ width: 150 }}
            placeholder="Pipedrive id (blank = auto)"
            title="Leave blank for reps who don't exist in Pipedrive — a synthetic owner id is minted so ownership/round-robin still work."
            value={form.pipedriveUserId}
            onChange={(e) => setForm({ ...form, pipedriveUserId: e.target.value.replace(/\D/g, "") })}
            disabled={!!form.linkRepId}
          />
          {data.unlinkedReps.length > 0 && (
            <select className="vmsel" style={{ width: "auto" }} value={form.linkRepId} onChange={(e) => setForm({ ...form, linkRepId: e.target.value })} title="Attach this login to an existing rep record instead of creating a new one">
              <option value="">— new rep record —</option>
              {data.unlinkedReps.map((r) => (
                <option key={r.repId} value={r.repId}>link: {r.name}</option>
              ))}
            </select>
          )}
          <button
            className="btn primary"
            style={{ padding: "6px 14px", fontSize: 13.5 }}
            disabled={busy || !form.name.trim() || !form.email.includes("@") || form.password.length < 8}
            onClick={async () => {
              const ok = await run(
                {
                  op: "create",
                  name: form.name,
                  email: form.email,
                  role: form.role,
                  password: form.password,
                  pipedriveUserId: form.pipedriveUserId ? Number(form.pipedriveUserId) : undefined,
                  linkRepId: form.linkRepId || undefined,
                },
                "✓ User created"
              );
              if (ok) {
                setAdding(false);
                setForm({ name: "", email: "", role: "sales", password: "", pipedriveUserId: "", linkRepId: "" });
              }
            }}
          >
            Create
          </button>
        </div>
      )}

      {users.map((u) => (
        <div key={u.authUserId} style={{ borderTop: "1px solid var(--border-soft)", padding: "10px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 14.5, opacity: u.active ? 1 : 0.5 }}>{u.name ?? u.email}</b>
            <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>{u.email}</span>
            <span className="chip stage" style={{ fontSize: 11.5 }}>{u.role}</span>
            {!u.active && <span className="chip stage" style={{ fontSize: 11.5, color: "var(--crit)" }}>deactivated</span>}
            {u.pipedriveUserId != null && (
              <span style={{ fontSize: 11.5, color: "var(--text-3)" }} title={u.pipedriveUserId >= 900_000_000 ? "Synthetic owner id (no Pipedrive account)" : "Pipedrive user id"}>
                #{u.pipedriveUserId}{u.pipedriveUserId >= 900_000_000 ? " (native)" : ""}
              </span>
            )}
            {u.telnyxNumber && <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>📞 {u.telnyxNumber}</span>}
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-3)" }}>
              {u.openDeals > 0 ? `${u.openDeals} open deals` : ""}
              {u.pools.length > 0 ? ` · pools: ${u.pools.join(", ")}` : ""}
            </span>
            <button
              className="btn ghost"
              style={{ padding: "3px 10px", fontSize: 12.5 }}
              onClick={() => {
                if (editing === u.authUserId) return setEditing(null);
                setEdit({ name: u.name ?? "", role: u.role, pipedriveUserId: u.pipedriveUserId != null ? String(u.pipedriveUserId) : "", password: "" });
                setEditing(u.authUserId);
              }}
            >
              {editing === u.authUserId ? "✕" : "✏️ Edit"}
            </button>
          </div>

          {editing === u.authUserId && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
              <input className="vmsel" style={{ width: 150 }} placeholder="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <select className="vmsel" style={{ width: "auto" }} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                <option value="sales">Sales</option>
                <option value="admin">Admin</option>
              </select>
              <input className="vmsel" style={{ width: 140 }} placeholder="Pipedrive id" value={edit.pipedriveUserId} onChange={(e) => setEdit({ ...edit, pipedriveUserId: e.target.value.replace(/\D/g, "") })} />
              <input className="vmsel" style={{ width: 170 }} placeholder="New password (optional)" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
              <button
                className="btn primary"
                style={{ padding: "5px 12px", fontSize: 13 }}
                disabled={busy}
                onClick={async () => {
                  const ok = await run(
                    {
                      op: "update",
                      authUserId: u.authUserId,
                      name: edit.name.trim() || undefined,
                      role: edit.role,
                      pipedriveUserId: edit.pipedriveUserId ? Number(edit.pipedriveUserId) : undefined,
                      password: edit.password || undefined,
                    },
                    "✓ Saved"
                  );
                  if (ok) setEditing(null);
                }}
              >
                Save
              </button>
              {u.active ? (
                <button
                  className="btn ghost"
                  style={{ padding: "5px 12px", fontSize: 13, color: "var(--warn)" }}
                  disabled={busy}
                  title={u.openDeals > 0 ? `${u.openDeals} open deals still assigned — reassign via the CRM owner filter or the stale sweep` : "Ban login + drop from all engine pools"}
                  onClick={() => {
                    if (armed !== `deact:${u.authUserId}`) return setArmed(`deact:${u.authUserId}`);
                    void run({ op: "deactivate", authUserId: u.authUserId }, "✓ Deactivated");
                  }}
                >
                  {armed === `deact:${u.authUserId}` ? `⏻ Really deactivate?${u.openDeals ? ` (${u.openDeals} open deals)` : ""}` : "⏻ Deactivate"}
                </button>
              ) : (
                <button className="btn ghost" style={{ padding: "5px 12px", fontSize: 13 }} disabled={busy} onClick={() => void run({ op: "reactivate", authUserId: u.authUserId }, "✓ Reactivated — re-enable engine pools if needed")}>
                  ↩ Reactivate
                </button>
              )}
              <button
                className="btn ghost"
                style={{ padding: "5px 12px", fontSize: 13, color: "var(--crit)", marginLeft: "auto" }}
                disabled={busy}
                title="Removes the login permanently. History (deals, calls, notes) keeps their name."
                onClick={() => {
                  if (armed !== `del:${u.authUserId}`) return setArmed(`del:${u.authUserId}`);
                  void run({ op: "delete", authUserId: u.authUserId }, "✓ Deleted");
                }}
              >
                {armed === `del:${u.authUserId}` ? "🗑 Really delete login?" : "🗑 Delete"}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
