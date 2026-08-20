"use client";

import { useEffect, useState } from "react";

interface Theme {
  key: string;
  name: string;
  intent: string | null;
  prompt_direction: string;
  channels: string[];
  sort_order: number;
  enabled: boolean;
}

/** ✨ Draft themes — the stable steering catalog for email/text generation. */
export function DraftThemesAdmin() {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [edit, setEdit] = useState<Partial<Theme> & { isNew?: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delArmed, setDelArmed] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/admin/draft-themes");
    const d = await r.json().catch(() => ({}));
    if (r.ok) setThemes(d.themes ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/draft-themes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      await load();
      return true;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 980, marginTop: 18 }}>
      <div className="panel-h" style={{ display: "flex", alignItems: "center" }}>
        ✨ Draft themes
        <button
          className="btn ghost"
          style={{ marginLeft: "auto", padding: "3px 11px", fontSize: 12.5 }}
          onClick={() => setEdit({ isNew: true, key: "", name: "", intent: "", prompt_direction: "", channels: ["email", "sms"], sort_order: 100 })}
        >
          ＋ Add theme
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 10 }}>
        The angles reps pick when generating an email/text (⭐ suggestion is ranked per deal automatically). Keys are stable so usage stats and the
        review below attach to them. {msg && <span style={{ color: "var(--crit)" }}>{msg}</span>}
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {themes.map((t) => (
          <div key={t.key} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "7px 10px", background: "var(--surface-2)", borderRadius: 8, opacity: t.enabled ? 1 : 0.5 }}>
            <b style={{ fontSize: 13.5, minWidth: 140 }}>{t.name}</b>
            <span style={{ fontSize: 12, color: "var(--text-3)", minWidth: 90 }}>{(t.channels ?? []).join(" + ")}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.prompt_direction}>
              {t.intent ?? t.prompt_direction}
            </span>
            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }} disabled={busy} onClick={() => setEdit({ ...t })}>✏️</button>
              <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 12 }} disabled={busy} onClick={() => void post({ op: "toggle", key: t.key, enabled: !t.enabled })}>
                {t.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="btn ghost"
                style={{ padding: "2px 8px", fontSize: 12, ...(delArmed === t.key ? { background: "var(--crit)", color: "#fff" } : {}) }}
                disabled={busy}
                onClick={() => {
                  if (delArmed === t.key) {
                    setDelArmed(null);
                    void post({ op: "delete", key: t.key });
                  } else {
                    setDelArmed(t.key);
                    setTimeout(() => setDelArmed((c) => (c === t.key ? null : c)), 3000);
                  }
                }}
              >
                {delArmed === t.key ? "Sure?" : "🗑"}
              </button>
            </span>
          </div>
        ))}
      </div>

      {edit && (
        <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--surface-2)", borderRadius: 10, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="vmsel" style={{ width: 170, fontSize: 13 }} placeholder="key_snake_case" value={edit.key ?? ""} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
            <input className="vmsel" style={{ width: 200, fontSize: 13 }} placeholder="Name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <input className="vmsel" style={{ flex: 1, minWidth: 220, fontSize: 13 }} placeholder="One-line intent (shown to reps)" value={edit.intent ?? ""} onChange={(e) => setEdit({ ...edit, intent: e.target.value })} />
          </div>
          <textarea
            className="vmsel"
            style={{ fontSize: 13, minHeight: 70, resize: "vertical" }}
            placeholder="Prompt direction — the steering text the generator follows"
            value={edit.prompt_direction ?? ""}
            onChange={(e) => setEdit({ ...edit, prompt_direction: e.target.value })}
          />
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
            {(["email", "sms"] as const).map((ch) => (
              <label key={ch} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={(edit.channels ?? []).includes(ch)}
                  onChange={(e) =>
                    setEdit({ ...edit, channels: e.target.checked ? [...(edit.channels ?? []), ch] : (edit.channels ?? []).filter((c) => c !== ch) })
                  }
                />
                {ch}
              </label>
            ))}
            <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
              sort
              <input className="vmsel" type="number" style={{ width: 70, fontSize: 13 }} value={edit.sort_order ?? 100} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} />
            </label>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn ghost" style={{ padding: "4px 12px", fontSize: 13 }} onClick={() => setEdit(null)}>Cancel</button>
              <button
                className="btn primary"
                style={{ padding: "4px 14px", fontSize: 13 }}
                disabled={busy}
                onClick={async () => {
                  const ok = await post({ op: "upsert", key: edit.key, name: edit.name, intent: edit.intent, promptDirection: edit.prompt_direction, channels: edit.channels, sortOrder: edit.sort_order });
                  if (ok) setEdit(null);
                }}
              >
                Save
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
