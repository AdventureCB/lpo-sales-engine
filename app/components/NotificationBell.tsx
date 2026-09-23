"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { publishNotifs } from "./notifStore";

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

const SCOPE_KEY = "notif_scope"; // admin's chosen scope, remembered per browser

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const h = ms / 3_600_000;
  if (ms < 0) return "now";
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Sidebar bell: new messages, missed calls, overdue tasks. Polls 45s.
 * The badge counts what appeared since you last looked — hovering the bell
 * (or opening it) marks everything seen. Admins pick a scope: whole team,
 * their own, or one rep; the badge follows the scope.
 */
export function NotificationBell() {
  const router = useRouter();
  const [badge, setBadge] = useState(0);
  const [overdueCount, setOverdueCount] = useState(0);
  const [items, setItems] = useState<Notif[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotifGroup | "all">("all");
  const [reps, setReps] = useState<{ id: string; name: string; email: string }[] | null>(null); // non-null = admin
  const [scope, setScope] = useState<string>(() => {
    try { return localStorage.getItem(SCOPE_KEY) || "team"; } catch { return "team"; }
  });
  const seenTimer = useRef<number | null>(null);

  const load = useCallback((s: string) => {
    fetch(`/api/notifications?scope=${encodeURIComponent(s)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setBadge(d.badge ?? 0);
        setOverdueCount(d.overdueCount ?? 0);
        setItems(d.items ?? []);
        setCounts(d.counts ?? {});
        if (Array.isArray(d.reps)) setReps(d.reps);
        publishNotifs(d.items ?? []); // feeds the Texts nav badge — no extra poll
      })
      .catch(() => {});
  }, []);

  const dismiss = useCallback((key: string) => {
    setItems((prev) => prev.filter((n) => n.key !== key)); // optimistic
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
    load(scope);
    const iv = setInterval(() => load(scope), 45_000);
    return () => clearInterval(iv);
  }, [load, scope]);

  // Seen = you looked. Hover counts (after a short dwell so a passing cursor doesn't).
  const markSeen = useCallback(() => {
    if (badge === 0) return;
    setBadge(0);
    void fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markSeen: true }),
    }).catch(() => {});
  }, [badge]);
  const onHoverStart = () => {
    if (seenTimer.current) window.clearTimeout(seenTimer.current);
    seenTimer.current = window.setTimeout(markSeen, 600);
  };
  const onHoverEnd = () => {
    if (seenTimer.current) window.clearTimeout(seenTimer.current);
    seenTimer.current = null;
  };

  const openPanel = () => {
    setOpen((v) => !v);
    if (!open) markSeen();
  };

  const changeScope = (s: string) => {
    setScope(s);
    try { localStorage.setItem(SCOPE_KEY, s); } catch {}
  };

  const scopeLabel = scope === "team" ? "Whole team" : scope === "mine" ? "Mine" : reps?.find((r) => `rep:${r.id}` === scope)?.name.split(" ")[0] ?? "Rep";

  return (
    <>
      <button
        className="btn ghost"
        style={{ width: "100%", justifyContent: "space-between", padding: "8px 12px", fontSize: 13.5 }}
        onClick={openPanel}
        onMouseEnter={onHoverStart}
        onMouseLeave={onHoverEnd}
        title={badge > 0 ? "New since you last looked — hover or open to clear" : "Notifications"}
      >
        <span>🔔 Notifications{reps && scope !== "team" ? <span style={{ color: "var(--text-3)", fontSize: 11.5 }}> · {scopeLabel}</span> : null}</span>
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

            {reps && (
              <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "0 4px 8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Show:</span>
                {[{ s: "team", label: "Whole team" }, { s: "mine", label: "Mine" }].map((o) => (
                  <button
                    key={o.s}
                    onClick={() => changeScope(o.s)}
                    className="btn ghost"
                    style={{ padding: "2px 9px", fontSize: 12, borderRadius: 999, background: scope === o.s ? "var(--accent)" : "transparent", color: scope === o.s ? "#fff" : "var(--text-2)" }}
                  >
                    {o.label}
                  </button>
                ))}
                <select
                  className="vmsel"
                  style={{ width: "auto", padding: "2px 6px", fontSize: 12, borderRadius: 999, ...(scope.startsWith("rep:") ? { borderColor: "var(--accent)" } : {}) }}
                  value={scope.startsWith("rep:") ? scope : ""}
                  onChange={(e) => e.target.value && changeScope(e.target.value)}
                >
                  <option value="">One rep…</option>
                  {reps.map((r) => (
                    <option key={r.id} value={`rep:${r.id}`}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}

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
