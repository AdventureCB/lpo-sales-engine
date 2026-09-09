"use client";

import { useEffect, useState } from "react";

/**
 * 🧰 Tools — launchpad for the other software the team lives in (Gorgias,
 * Shopify, ClickUp, Calendly, a plain browser, Lone Peak Ops). In the
 * companion these open as NATIVE tool windows (companion ≥0.2.3): unlike
 * iframes they aren't blocked by X-Frame-Options, logins persist, and focus
 * time flows into engagement tracking. In a plain browser (or an older
 * companion) they open as normal tabs/windows instead — no tracking there.
 */

interface Tool {
  key: string;
  label: string;
  emoji: string;
  url: string;
}

export function ToolsView() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Tool[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [companionOk, setCompanionOk] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/tools")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setTools(d.tools);
        setIsAdmin(!!d.isAdmin);
      })
      .catch(() => {});
    const t = (window as any).__TAURI__;
    if (!t) setCompanionOk(false);
    else
      t.core
        .invoke("app_version")
        .then((v: string) => setCompanionOk(v >= "0.2.3"))
        .catch(() => setCompanionOk(false));
  }, []);

  const open = async (tool: Tool) => {
    if (!tool.url) return;
    const t = (window as any).__TAURI__;
    if (t?.core?.invoke) {
      try {
        // group: on companion ≥0.2.4 all tools except Ops merge into one
        // native-tabbed window (max 3 windows total); 0.2.3 ignores it.
        await t.core.invoke("open_tool_window", {
          url: tool.url,
          label: tool.key,
          title: tool.label,
          group: tool.key === "ops" ? null : "tools",
        });
        return;
      } catch {
        // Older companion (no open_tool_window) → default browser.
        try {
          await t.core.invoke("open_external", { url: tool.url });
          return;
        } catch {}
      }
    }
    window.open(tool.url, `lpo-tool-${tool.key}`);
  };

  const save = async () => {
    const r = await fetch("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tools: draft }),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setTools(d.tools);
      setEditing(false);
      setMsg("✓ Saved");
      setTimeout(() => setMsg(null), 3000);
    } else setMsg("Save failed");
  };

  return (
    <>
      <div className="viewhead">
        <h1>🧰 Tools</h1>
      </div>
      <p className="viewsub">
        Your other workspaces, one click away. In the companion these open as app windows — you stay signed in, and
        time spent in them counts toward engagement.
        {companionOk === false && (
          <span style={{ color: "var(--text-3)" }}>
            {" "}(You&apos;re not on companion 0.2.3+, so these open in your browser and time isn&apos;t tracked.)
          </span>
        )}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, maxWidth: 900 }}>
        {tools.filter((t) => t.url || isAdmin).map((t) => (
          <button
            key={t.key}
            className="card"
            onClick={() => open(t)}
            disabled={!t.url}
            style={{
              padding: "22px 16px",
              textAlign: "center",
              cursor: t.url ? "pointer" : "not-allowed",
              opacity: t.url ? 1 : 0.5,
              border: "1px solid var(--border-soft)",
              background: "var(--surface-2)",
              borderRadius: 12,
            }}
            title={t.url || "No URL configured yet"}
          >
            <div style={{ fontSize: 34 }}>{t.emoji}</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 8, color: "var(--text-1)" }}>{t.label}</div>
            {!t.url && <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}>URL not set</div>}
          </button>
        ))}
      </div>

      {msg && <div className="viewsub" style={{ color: "var(--good)", marginTop: 10 }}>{msg}</div>}

      {isAdmin && !editing && (
        <button className="btn ghost" style={{ marginTop: 18 }} onClick={() => { setDraft(tools.map((t) => ({ ...t }))); setEditing(true); }}>
          ✏️ Edit tools
        </button>
      )}
      {isAdmin && editing && (
        <div className="card" style={{ marginTop: 18, padding: "14px 16px", maxWidth: 720, display: "grid", gap: 8 }}>
          <b style={{ fontSize: 14.5 }}>Edit tools</b>
          {draft.map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input className="vmsel" style={{ width: 54 }} value={t.emoji} onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)))} />
              <input className="vmsel" style={{ width: 150 }} placeholder="Label" value={t.label} onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input className="vmsel" style={{ flex: 1 }} placeholder="https://…" value={t.url} onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
              <button className="btn ghost" style={{ padding: "4px 9px", fontSize: 12 }} title="Remove" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                🗑
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn ghost"
              style={{ fontSize: 13 }}
              onClick={() => setDraft((d) => [...d, { key: `tool${Date.now() % 100000}`, label: "", emoji: "🔗", url: "" }])}
            >
              ＋ Add tool
            </button>
            <button className="btn primary" style={{ marginLeft: "auto" }} onClick={save}>Save</button>
            <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
            Gorgias needs your workspace URL (yourcompany.gorgias.com); Shopify can be the store admin URL. Lone Peak
            Ops activates once its URL is set.
          </div>
        </div>
      )}
    </>
  );
}
