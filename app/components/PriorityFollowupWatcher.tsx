"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * ⭐ Priority follow-up watcher — mounted on every page. Polls the rep's own
 * priority activities (60s); from T-10min a top countdown banner ticks down
 * to the scheduled time; at T a centered popup takes over — unless the rep
 * already has that deal's page open. Snooze/dismiss state is per-machine
 * (localStorage) so the popup doesn't nag forever.
 */

interface Item {
  id: string;
  subject: string;
  type: string;
  dueAt: string;
  dealId: string | null;
  dealTitle: string | null;
}

const LEAD_MS = 10 * 60_000; // banner appears T-10min
const OVERDUE_MS = 2 * 3600_000; // popup persists up to 2h past due
const SNOOZE_MS = 10 * 60_000;

function readMap(key: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}
function writeMap(key: string, m: Record<string, number>) {
  try {
    localStorage.setItem(key, JSON.stringify(m));
  } catch {}
}

const TYPE_ICON: Record<string, string> = { call: "📞", sms: "💬", email: "✉️", task: "📋", meeting: "📅" };

export function PriorityFollowupWatcher() {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<Item[]>([]);
  const [, setTick] = useState(0); // 1s re-render while something is live

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/crm/priority-followups")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d && setItems(d.items ?? []))
        .catch(() => {});
    void load();
    const poll = setInterval(load, 60_000);
    const tick = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const now = Date.now();
  const dismissed = readMap("lpo:pfu-dismissed");
  const snoozed = readMap("lpo:pfu-snoozed");

  const live = items.filter((it) => {
    if (dismissed[it.id]) return false;
    const due = Date.parse(it.dueAt);
    return due - now <= LEAD_MS && now - due <= OVERDUE_MS;
  });
  if (live.length === 0) return null;

  // Soonest first; one banner/popup at a time keeps it readable.
  const it = [...live].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
  const due = Date.parse(it.dueAt);
  const untilMs = due - now;
  const onDealPage = !!it.dealId && (pathname ?? "").includes(`/crm/deal/${it.dealId}`);
  const isSnoozed = (snoozed[it.id] ?? 0) > now;

  const dismiss = () => {
    writeMap("lpo:pfu-dismissed", { ...dismissed, [it.id]: now });
    setTick((t) => t + 1);
  };
  const snooze = () => {
    writeMap("lpo:pfu-snoozed", { ...snoozed, [it.id]: now + SNOOZE_MS });
    setTick((t) => t + 1);
  };
  const markDone = () => {
    void fetch("/api/crm/priority-followups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id }),
    }).catch(() => {});
    setItems((prev) => prev.filter((x) => x.id !== it.id));
  };
  const openDeal = () => {
    if (it.dealId) router.push(`/crm/deal/${it.dealId}`);
  };

  const mm = Math.floor(Math.abs(untilMs) / 60_000);
  const ss = Math.floor((Math.abs(untilMs) % 60_000) / 1000);
  const clock = `${mm}:${String(ss).padStart(2, "0")}`;

  // ── Before the scheduled time: countdown banner ──────────────────────────
  if (untilMs > 0) {
    return (
      <div
        style={{
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1050,
          background: "var(--surface-1)",
          border: "2px solid #d99a2b",
          borderRadius: 12,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          boxShadow: "0 10px 40px rgba(0,0,0,0.45)",
          cursor: it.dealId ? "pointer" : "default",
        }}
        onClick={openDeal}
        title={it.dealId ? "Open the deal" : undefined}
      >
        <span style={{ fontSize: 18 }}>⭐</span>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>
            {TYPE_ICON[it.type] ?? "📋"} {it.subject}
            {it.dealTitle ? <span style={{ fontWeight: 400, color: "var(--text-2)" }}> — {it.dealTitle}</span> : null}
          </div>
          <div style={{ fontSize: 12.5, color: "#d99a2b", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            in {clock}
          </div>
        </div>
        <button
          className="btn ghost"
          style={{ padding: "3px 9px", fontSize: 12 }}
          title="Hide this reminder"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  // ── At/after the scheduled time: centered popup (not on the deal page) ───
  if (onDealPage || isSnoozed) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1060, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center" }}>
      <div
        className="card"
        style={{
          background: "var(--surface-1)",
          border: "2px solid #d99a2b",
          borderRadius: 16,
          padding: "28px 34px",
          minWidth: 340,
          maxWidth: "90vw",
          textAlign: "center",
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>⭐</div>
        <div style={{ fontSize: 12.5, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Priority follow-up — due now
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, marginTop: 6 }}>
          {TYPE_ICON[it.type] ?? "📋"} {it.subject}
        </div>
        {it.dealTitle && <div style={{ fontSize: 14, color: "var(--text-2)", marginTop: 2 }}>{it.dealTitle}</div>}
        <div style={{ fontSize: 12.5, color: "var(--crit, #c9502e)", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
          {untilMs < -30_000 ? `${clock} overdue` : "right now"}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18, flexWrap: "wrap" }}>
          {it.dealId && (
            <button className="btn primary" style={{ padding: "10px 22px", fontSize: 14.5 }} onClick={openDeal}>
              📋 Open deal
            </button>
          )}
          <button className="btn" style={{ padding: "10px 16px", fontSize: 14.5 }} onClick={markDone}>
            ✓ Done
          </button>
          <button className="btn" style={{ padding: "10px 16px", fontSize: 14.5 }} onClick={snooze}>
            💤 10 min
          </button>
          <button className="btn ghost" style={{ padding: "10px 14px", fontSize: 14.5 }} onClick={dismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
