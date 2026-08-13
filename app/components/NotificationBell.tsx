"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

type NotifGroup = "deals" | "notes" | "comms" | "tasks";
interface Notif {
  key: string;
  kind: string;
  group: NotifGroup;
  title: string;
  sub: string | null;
  at: string;
  href: string;
  isNew: boolean;
}

const FILTERS: { g: NotifGroup | "all"; label: string }[] = [
  { g: "all", label: "All" },
  { g: "deals", label: "New deals" },
  { g: "notes", label: "Notes" },
  { g: "comms", label: "Calls & texts" },
  { g: "tasks", label: "Tasks" },
];

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const h = ms / 3_600_000;
  if (ms < 0) return "now";
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Sidebar bell: new messages, missed calls, overdue tasks. Polls 45s. */
export function NotificationBell() {
  const router = useRouter();
  const [badge, setBadge] = useState(0);
  const [overdueCount, setOverdueCount] = useState(0);
  const [items, setItems] = useState<Notif[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotifGroup | "all">("all");

  const load = useCallback(() => {
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setBadge(d.badge ?? 0);
        setOverdueCount(d.overdueCount ?? 0);
        setItems(d.items ?? []);
        setCounts(d.counts ?? {});
      })
      .catch(() => {});
  }, []);

  const dismiss = useCallback((key: string) => {
    setItems((prev) => prev.filter((n) => n.key !== key)); // optimistic
    setBadge((b) => Math.max(0, b - 1));
    void fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismiss: key }),
    }).catch(() => {});
  }, []);

  const dismissAll = useCallback((visible: Notif[]) => {
    const keys = visible.map((n) => n.key);
    setItems((prev) => prev.filter((n) => !keys.includes(n.key)));
    void fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissKeys: keys }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 45_000);
    return () => clearInterval(iv);
  }, [load]);

  const openPanel = () => {
    setOpen((v) => !v);
    if (!open) {
      // Viewing the panel acknowledges the new-item portion of the badge.
      void fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markSeen: true }),
      })
        .then(() => setBadge(overdueCount))
        .catch(() => {});
    }
  };

  return (
    <>
      <button
        className="btn ghost"
        style={{ width: "100%", justifyContent: "space-between", padding: "8px 12px", fontSize: 13.5 }}
        onClick={openPanel}
      >
        <span>🔔 Notifications</span>
        {badge > 0 && (
          <span
            style={{
              background: "var(--accent)",
              color: "#fff",
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 12,
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </button>

      {/* Portaled to <body>: the sidebar is a stacking context (z-index 50),
          so a fixed panel rendered inside it would paint UNDER any page
          element with a higher z-index (dispo bar, phone dock, sticky cols). */}
      {open && typeof document !== "undefined" && createPortal(
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 890 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: "fixed",
              left: 224,
              bottom: 16,
              zIndex: 891,
              width: 380,
              maxWidth: "80vw",
              maxHeight: "72vh",
              overflowY: "auto",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 10,
              boxShadow: "0 16px 44px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", padding: "2px 6px 8px" }}>
              <b style={{ fontSize: 14 }}>Notifications</b>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-3)" }}>
                last 48h{overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
              </span>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "0 4px 8px" }}>
              {FILTERS.map((f) => {
                const n = f.g === "all" ? items.length : counts[f.g] ?? 0;
                return (
                  <button
                    key={f.g}
                    onClick={() => setFilter(f.g)}
                    className="btn ghost"
                    style={{
                      padding: "3px 9px",
                      fontSize: 12,
                      borderRadius: 999,
                      background: filter === f.g ? "var(--accent)" : "transparent",
                      color: filter === f.g ? "#fff" : "var(--text-2)",
                    }}
                  >
                    {f.label}{n > 0 ? ` ${n}` : ""}
                  </button>
                );
              })}
            </div>

            {(() => {
              const visible = filter === "all" ? items : items.filter((n) => n.group === filter);
              if (visible.length === 0)
                return <div style={{ fontSize: 13.5, color: "var(--text-3)", padding: "6px 6px 10px" }}>All clear. 🎉</div>;
              return (
                <>
                  <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 4px 4px" }}>
                    <button className="btn ghost" style={{ fontSize: 11.5, padding: "2px 8px", color: "var(--text-3)" }} onClick={() => dismissAll(visible)}>
                      Dismiss {filter === "all" ? "all" : "these"}
                    </button>
                  </div>
                  {visible.map((n) => (
                    <div
                      key={n.key}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 6,
                        padding: "8px 9px",
                        borderRadius: 9,
                        marginBottom: 2,
                        background: n.kind === "overdue" ? "rgba(224,72,72,0.10)" : n.isNew ? "var(--surface-3)" : "transparent",
                      }}
                    >
                      <div
                        onClick={() => {
                          setOpen(false);
                          router.push(n.href);
                        }}
                        style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span style={{ fontSize: 13.5, fontWeight: n.isNew ? 750 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                            {n.title}
                          </span>
                          <span style={{ fontSize: 11.5, color: "var(--text-3)", flexShrink: 0 }}>{relTime(n.at)}</span>
                        </div>
                        {n.sub && (
                          <div style={{ fontSize: 12.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {n.sub}
                          </div>
                        )}
                      </div>
                      <button
                        title="Dismiss"
                        onClick={(e) => { e.stopPropagation(); dismiss(n.key); }}
                        style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        </>,
        document.body
      )}
    </>
  );
}
