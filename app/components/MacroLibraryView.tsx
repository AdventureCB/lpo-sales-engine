"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PLACEHOLDERS } from "@/lib/placeholders";

/**
 * Macro library. The shared TEMPLATE catalog anyone can add to; each rep
 * toggles a template on to get a personal editable copy (editing a copy
 * never changes the template). Organized by medium (channel) then folder.
 * Admins can inspect any rep's personal library.
 */

interface Macro {
  id: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  folder: string | null;
  is_template: boolean;
  template_id: string | null;
  owner_email: string | null;
}

const CHANNELS = [
  ["sms", "💬 Text"],
  ["whatsapp", "🟢 WhatsApp"],
  ["email", "✉️ Email"],
  ["any", "Any channel"],
] as const;
const chLabel = (c: string) => CHANNELS.find(([v]) => v === c)?.[1] ?? c;

async function post(payload: any): Promise<{ ok: boolean; id?: string }> {
  const r = await fetch("/api/crm/comm-library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!r?.ok) return { ok: false };
  const d = await r.json().catch(() => ({}));
  return { ok: true, id: d.id };
}

/** Textarea with a one-click placeholder dropdown that inserts at the cursor. */
function BodyField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    // Restore cursor just after the inserted token.
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = start + token.length;
      }
    });
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
        <select
          className="vmsel"
          style={{ width: "auto", fontSize: 12.5 }}
          value=""
          onChange={(e) => { if (e.target.value) insert(e.target.value); e.target.value = ""; }}
        >
          <option value="">+ Insert placeholder…</option>
          {PLACEHOLDERS.map((p) => (
            <option key={p.token} value={p.token}>{p.label}</option>
          ))}
        </select>
      </div>
      <textarea
        ref={ref}
        className="vmsel"
        rows={4}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ resize: "vertical", width: "100%" }}
      />
    </div>
  );
}

/** Create/edit form for a macro (template or personal copy). */
function MacroForm({
  init,
  folders,
  onSave,
  onCancel,
}: {
  init: Partial<Macro>;
  folders: string[];
  onSave: (m: Partial<Macro>) => Promise<void>;
  onCancel: () => void;
}) {
  const [m, setM] = useState<Partial<Macro>>({ channel: "email", ...init });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Macro>) => setM((c) => ({ ...c, ...p }));

  return (
    <div className="card" style={{ marginBottom: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <select className="vmsel" style={{ width: "auto" }} value={m.channel} onChange={(e) => set({ channel: e.target.value })}>
          {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input className="vmsel" style={{ flex: 1 }} placeholder="Macro name" value={m.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <input
        className="vmsel"
        list="macro-folders"
        placeholder="Folder (optional) — e.g. Follow-ups"
        value={m.folder ?? ""}
        onChange={(e) => set({ folder: e.target.value })}
      />
      <datalist id="macro-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      {m.channel === "email" && (
        <input className="vmsel" placeholder="Subject (email)" value={m.subject ?? ""} onChange={(e) => set({ subject: e.target.value })} />
      )}
      <BodyField value={m.body ?? ""} onChange={(v) => set({ body: v })} placeholder="Message body… use the placeholder dropdown for merge fields" />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          disabled={busy || !m.name?.trim() || !m.body?.trim()}
          onClick={async () => { setBusy(true); await onSave(m); setBusy(false); }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Group macros by channel, then folder, preserving order. */
function grouped(list: Macro[]): { channel: string; folders: { folder: string; items: Macro[] }[] }[] {
  const byCh = new Map<string, Map<string, Macro[]>>();
  for (const m of list) {
    if (!byCh.has(m.channel)) byCh.set(m.channel, new Map());
    const f = m.folder || "General";
    const fm = byCh.get(m.channel)!;
    if (!fm.has(f)) fm.set(f, []);
    fm.get(f)!.push(m);
  }
  return [...byCh.entries()].map(([channel, fm]) => ({
    channel,
    folders: [...fm.entries()].map(([folder, items]) => ({ folder, items })),
  }));
}

export function MacroLibraryView({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<"mine" | "templates" | "team">("mine");
  const [data, setData] = useState<any>(null);
  const [teamRep, setTeamRep] = useState<string>("");
  const [creating, setCreating] = useState<null | "template" | "mine">(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback((repEmail?: string) => {
    const qs = repEmail ? `?repEmail=${encodeURIComponent(repEmail)}` : "";
    fetch(`/api/crm/comm-library${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
  }, []);
  useEffect(() => load(), [load]);

  if (!data) return <div className="viewsub">Loading…</div>;

  const templates: Macro[] = data.templates ?? [];
  const myMacros: Macro[] = data.myMacros ?? [];
  const enabled = new Set<string>(data.enabledTemplateIds ?? []);
  const allFolders = [...new Set([...templates, ...myMacros].map((m) => m.folder).filter(Boolean))] as string[];

  const flash = (ok: boolean) => { setMsg(ok ? "✓ Saved" : "⚠ Failed"); setTimeout(() => setMsg(null), 1500); };

  const toggle = async (templateId: string, on: boolean) => {
    flash((await post({ op: "toggle_template", templateId, on })).ok);
    load();
  };

  return (
    <div>
      <div className="viewhead" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1>✍️ Macro Library</h1>
        <Link href="/settings" style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-3)" }}>← Settings</Link>
      </div>
      <p className="viewsub">
        Add a message to the shared <strong>template catalog</strong>; toggle a template on to drop an editable copy into
        <strong> your macros</strong>. Editing your copy never changes the template. {msg && <span style={{ color: "var(--good)" }}>· {msg}</span>}
      </p>

      <div className="range-toggle" style={{ marginBottom: 16 }}>
        <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>My macros ({myMacros.length})</button>
        <button className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>Templates ({templates.length})</button>
        {isAdmin && <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>Team</button>}
      </div>

      {/* MY MACROS */}
      {tab === "mine" && (
        <>
          {creating === "mine" ? (
            <MacroForm
              init={{}}
              folders={allFolders}
              onCancel={() => setCreating(null)}
              onSave={async (m) => {
                // Adding to the library publishes a template; auto-enable it so
                // a copy lands in the creator's macros immediately.
                const res = await post({ op: "template_upsert", macro: m });
                if (res.id) await post({ op: "toggle_template", templateId: res.id, on: true });
                setCreating(null);
                load();
              }}
            />
          ) : (
            <button className="btn" onClick={() => setCreating("mine")} style={{ marginBottom: 12 }}>+ New macro (adds a template + enables it)</button>
          )}
          {myMacros.length === 0 && <div className="viewsub">No macros yet. Toggle templates on, or add one.</div>}
          {grouped(myMacros).map((g) => (
            <div key={g.channel} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-2)", margin: "4px 0" }}>{chLabel(g.channel)}</div>
              {g.folders.map((f) => (
                <div key={f.folder} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.4, margin: "2px 0 4px" }}>📁 {f.folder}</div>
                  {f.items.map((m) =>
                    editId === m.id ? (
                      <MacroForm
                        key={m.id}
                        init={m}
                        folders={allFolders}
                        onCancel={() => setEditId(null)}
                        onSave={async (patch) => { flash((await post({ op: "macro_upsert", macro: { ...patch, id: m.id } })).ok); setEditId(null); load(); }}
                      />
                    ) : (
                      <div key={m.id} className="card" style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name} {m.template_id && <span className="chip stage" style={{ fontSize: 10.5 }}>from template</span>}</div>
                          {m.subject && <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>Subject: {m.subject}</div>}
                          <div style={{ fontSize: 12.5, color: "var(--text-2)", whiteSpace: "pre-wrap", marginTop: 2 }}>{m.body}</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button className="btn ghost" style={{ fontSize: 12, padding: "3px 9px" }} onClick={() => setEditId(m.id)}>Edit</button>
                          <button className="btn ghost" style={{ fontSize: 12, padding: "3px 9px", color: "var(--crit)" }} onClick={async () => { await post({ op: "macro_delete", id: m.id }); load(); }}>Remove</button>
                        </div>
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {/* TEMPLATES */}
      {tab === "templates" && (
        <>
          {creating === "template" ? (
            <MacroForm init={{}} folders={allFolders} onCancel={() => setCreating(null)} onSave={async (m) => { const r = await post({ op: "template_upsert", macro: m }); flash(r.ok); setCreating(null); load(); }} />
          ) : (
            <button className="btn" onClick={() => setCreating("template")} style={{ marginBottom: 12 }}>+ Add template</button>
          )}
          {grouped(templates).map((g) => (
            <div key={g.channel} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-2)", margin: "4px 0" }}>{chLabel(g.channel)}</div>
              {g.folders.map((f) => (
                <div key={f.folder} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.4, margin: "2px 0 4px" }}>📁 {f.folder}</div>
                  {f.items.map((m) => (
                    <div key={m.id} className="card" style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 2 }} title={enabled.has(m.id) ? "In your macros" : "Add to your macros"}>
                        <input type="checkbox" checked={enabled.has(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
                      </label>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
                        {m.subject && <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>Subject: {m.subject}</div>}
                        <div style={{ fontSize: 12.5, color: "var(--text-2)", whiteSpace: "pre-wrap", marginTop: 2 }}>{m.body}</div>
                      </div>
                      {(isAdmin || m.owner_email === data.viewEmail) && (
                        <button className="btn ghost" style={{ fontSize: 12, padding: "3px 9px", color: "var(--crit)" }} onClick={async () => { await post({ op: "template_delete", id: m.id }); load(); }}>Delete</button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {/* TEAM (admin) */}
      {tab === "team" && isAdmin && (
        <>
          <select className="vmsel" style={{ width: "auto", marginBottom: 12 }} value={teamRep} onChange={(e) => { setTeamRep(e.target.value); load(e.target.value); }}>
            <option value="">Pick a rep…</option>
            {(data.reps ?? []).map((r: any) => <option key={r.email} value={r.email}>{r.name}</option>)}
          </select>
          {teamRep && myMacros.length === 0 && <div className="viewsub">This rep has no personal macros.</div>}
          {teamRep && grouped(myMacros).map((g) => (
            <div key={g.channel} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-2)" }}>{chLabel(g.channel)}</div>
              {g.folders.map((f) => (
                <div key={f.folder} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", textTransform: "uppercase" }}>📁 {f.folder}</div>
                  {f.items.map((m) => (
                    <div key={m.id} className="card" style={{ marginBottom: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
                      <div style={{ fontSize: 12.5, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>{m.body}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
