"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PLACEHOLDERS } from "@/lib/placeholders";
import { isHtml, htmlToPlain } from "@/lib/richtext";
import RichTextEditor from "./RichTextEditor";

/** List previews show HTML macro bodies as readable text, not tag soup. */
const previewText = (body: string) => (isHtml(body) ? htmlToPlain(body) : body);

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
  asset_ids?: string[];
}
interface AssetLite { id: string; kind: string; name: string }

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

/** Body editor: rich text for email macros, plain textarea (with placeholder dropdown) otherwise. */
function BodyField({ value, onChange, placeholder, rich }: { value: string; onChange: (v: string) => void; placeholder?: string; rich?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  if (rich) return <RichTextEditor value={value} onChange={onChange} placeholder={placeholder} showPlaceholders />;
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
  assets,
  onSave,
  onCancel,
}: {
  init: Partial<Macro>;
  folders: string[];
  assets: AssetLite[];
  onSave: (m: Partial<Macro>) => Promise<void>;
  onCancel: () => void;
}) {
  const [m, setM] = useState<Partial<Macro>>({ channel: "email", asset_ids: [], ...init });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Macro>) => setM((c) => ({ ...c, ...p }));
  const toggleAsset = (id: string) =>
    setM((c) => {
      const cur = c.asset_ids ?? [];
      return { ...c, asset_ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });

  return (
    <div className="card" style={{ marginBottom: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <select
          className="vmsel"
          style={{ width: "auto" }}
          value={m.channel}
          onChange={(e) => {
            const ch = e.target.value;
            // Leaving the email (HTML) editor for a plain channel → flatten the draft.
            const body = ch !== "email" && m.body && isHtml(m.body) ? htmlToPlain(m.body) : m.body;
            set({ channel: ch, body });
          }}
        >
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
      <BodyField rich={m.channel === "email"} value={m.body ?? ""} onChange={(v) => set({ body: v })} placeholder="Message body… use the placeholder dropdown for merge fields" />
      {assets.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-3)", marginBottom: 4 }}>
            Pre-assigned links &amp; attachments (applied when this macro is used)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {assets.map((a) => (
              <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
                <input type="checkbox" checked={(m.asset_ids ?? []).includes(a.id)} onChange={() => toggleAsset(a.id)} />
                {a.kind === "media" ? "📎" : "🔗"} {a.name}
              </label>
            ))}
          </div>
        </div>
      )}
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
  const [tab, setTab] = useState<"mine" | "templates" | "assets" | "team">("mine");
  const [data, setData] = useState<any>(null);
  const [teamRep, setTeamRep] = useState<string>("");
  const [creating, setCreating] = useState<null | "template" | "mine">(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Asset add form
  const [aName, setAName] = useState("");
  const [aUrl, setAUrl] = useState("");
  const [uploading, setUploading] = useState(false);

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
        <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>Assets ({(data.assets ?? []).length})</button>
        {isAdmin && <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>Team</button>}
      </div>

      {tab === "assets" && (
        <>
          <p className="viewsub" style={{ marginTop: 0 }}>
            Links and files any rep can drop into a message. URL assets insert as clickable link text; media assets attach to emails.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
            <input className="vmsel" style={{ minWidth: 140 }} placeholder="Name (e.g. 3D Builder)" value={aName} onChange={(e) => setAName(e.target.value)} />
            <input className="vmsel" style={{ flex: 1, minWidth: 180 }} placeholder="https://… (for a URL asset)" value={aUrl} onChange={(e) => setAUrl(e.target.value)} />
            <button
              className="btn primary"
              disabled={!aName.trim() || !aUrl.trim()}
              onClick={async () => { flash((await post({ op: "asset", asset: { kind: "url", name: aName, url: aUrl } })).ok); setAName(""); setAUrl(""); load(); }}
            >
              Add URL
            </button>
            <label className="btn" style={{ cursor: aName.trim() && !uploading ? "pointer" : "not-allowed", opacity: aName.trim() && !uploading ? 1 : 0.5 }}>
              {uploading ? "Uploading…" : "📎 Upload media"}
              <input
                type="file"
                accept="image/*,application/pdf"
                style={{ display: "none" }}
                disabled={!aName.trim() || uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  const dataUrl: string = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(file); });
                  const r = await fetch("/api/crm/comm-library/upload", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: aName.trim(), filename: file.name, mimeType: file.type || "application/octet-stream", dataBase64: dataUrl.split(",")[1] ?? "" }),
                  }).catch(() => null);
                  setUploading(false); e.target.value = "";
                  if (r?.ok) { setAName(""); flash(true); load(); } else flash(false);
                }}
              />
            </label>
          </div>
          {(data.assets ?? []).map((a: any) => (
            <div key={a.id} className="card" style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 18 }}>{a.kind === "media" ? "🖼" : "🔗"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{a.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.kind === "media" ? "attachment" : a.url}</div>
              </div>
              {(isAdmin || a.owner_email === data.viewEmail || !a.owner_email) && (
                <button className="btn ghost" style={{ fontSize: 12, padding: "3px 9px", color: "var(--crit)" }} onClick={async () => { await post({ op: "asset_delete", id: a.id }); load(); }}>Delete</button>
              )}
            </div>
          ))}
        </>
      )}

      {/* MY MACROS */}
      {tab === "mine" && (
        <>
          {creating === "mine" ? (
            <MacroForm
              init={{}}
              folders={allFolders}
              assets={data.assets ?? []}
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
                        assets={data.assets ?? []}
                        onCancel={() => setEditId(null)}
                        onSave={async (patch) => { flash((await post({ op: "macro_upsert", macro: { ...patch, id: m.id } })).ok); setEditId(null); load(); }}
                      />
                    ) : (
                      <div key={m.id} className="card" style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name} {m.template_id && <span className="chip stage" style={{ fontSize: 10.5 }}>from template</span>}</div>
                          {m.subject && <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>Subject: {m.subject}</div>}
                          <div style={{ fontSize: 12.5, color: "var(--text-2)", whiteSpace: "pre-wrap", marginTop: 2 }}>{previewText(m.body)}</div>
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
            <MacroForm init={{}} folders={allFolders} assets={data.assets ?? []} onCancel={() => setCreating(null)} onSave={async (m) => { const r = await post({ op: "template_upsert", macro: m }); flash(r.ok); setCreating(null); load(); }} />
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
                        <div style={{ fontSize: 12.5, color: "var(--text-2)", whiteSpace: "pre-wrap", marginTop: 2 }}>{previewText(m.body)}</div>
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
                      <div style={{ fontSize: 12.5, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>{previewText(m.body)}</div>
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
