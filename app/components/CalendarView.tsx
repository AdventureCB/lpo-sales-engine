"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { isAllDayIso, activityDayKey, splitDue, combineDue } from "@/lib/allday";

interface CalActivity {
  id: string;
  type: string;
  subject: string | null;
  dueAt: string;
  done: boolean;
  actor: string | null;
  dealId: string | null;
  dealTitle: string | null;
  contactName: string | null;
  ownerPipedriveId: number | null;
}

type CalView = "month" | "week" | "day";

const TYPE_ICON: Record<string, string> = {
  call: "📞", task: "📋", meeting: "📅", email: "✉️", sms: "💬", note: "📝",
};

const OWNERS: { id: number; label: string }[] = [
  { id: 24081760, label: "Parker" },
  { id: 24391245, label: "Jackson" },
  { id: 24723797, label: "Cainen" },
  { id: 23851101, label: "Gabi" },
];

const DAY_MS = 86_400_000;

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Monday-start week beginning for a date. */
function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function CalendarView({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<CalView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [activities, setActivities] = useState<CalActivity[]>([]);
  const [repFilter, setRepFilter] = useState<string>("all"); // admin only
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalAct, setModalAct] = useState<CalActivity | null>(null);
  const [edDate, setEdDate] = useState("");
  const [edTime, setEdTime] = useState("");

  const openModal = (a: CalActivity) => {
    const s = splitDue(a.dueAt);
    setEdDate(s.date);
    setEdTime(s.time);
    setModalAct(a);
  };

  const reschedule = async () => {
    if (!modalAct?.dealId || !edDate || saving) return;
    setSaving(true);
    await fetch("/api/crm/deal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: modalAct.dealId,
        editActivity: { activityId: modalAct.id, dueAt: combineDue(edDate, edTime) },
      }),
    }).catch(() => {});
    setSaving(false);
    setModalAct(null);
    void load();
  };

  // Visible range per view (month grid over-fetches the padding days too).
  const range = useMemo(() => {
    if (view === "day") {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      return { start: s, end: new Date(s.getTime() + DAY_MS) };
    }
    if (view === "week") {
      const s = weekStart(anchor);
      return { start: s, end: new Date(s.getTime() + 7 * DAY_MS) };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = weekStart(first);
    return { start: gridStart, end: new Date(gridStart.getTime() + 42 * DAY_MS) };
  }, [view, anchor]);

  const load = useCallback(() => {
    const qs = new URLSearchParams({
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    });
    fetch(`/api/calendar?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setActivities(d.activities ?? []))
      .catch((e) => setError(String(e)));
  }, [range.start.getTime(), range.end.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () =>
      activities.filter(
        (a) => !isAdmin || repFilter === "all" || String(a.ownerPipedriveId ?? "") === repFilter
      ),
    [activities, isAdmin, repFilter]
  );

  const byDay = useMemo(() => {
    const m = new Map<string, CalActivity[]>();
    for (const a of shown) {
      const k = activityDayKey(a.dueAt); // all-day → its UTC date; timed → local date
      const list = m.get(k) ?? [];
      list.push(a);
      m.set(k, list);
    }
    return m;
  }, [shown]);

  const step = (dir: 1 | -1) => {
    const d = new Date(anchor);
    if (view === "day") d.setDate(d.getDate() + dir);
    else if (view === "week") d.setDate(d.getDate() + 7 * dir);
    else d.setMonth(d.getMonth() + dir);
    setAnchor(d);
  };

  const markDone = async (a: CalActivity) => {
    if (!a.dealId || saving) return;
    setSaving(true);
    await fetch("/api/crm/deal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.dealId, completeActivityId: a.id }),
    }).catch(() => {});
    setSaving(false);
    void load();
  };

  const todayKey = dayKey(new Date());
  const isPast = (a: CalActivity) => !a.done && Date.parse(a.dueAt) < Date.now();

  const label =
    view === "month"
      ? anchor.toLocaleDateString([], { month: "long", year: "numeric" })
      : view === "week"
        ? `${weekStart(anchor).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(weekStart(anchor).getTime() + 6 * DAY_MS).toLocaleDateString([], { month: "short", day: "numeric" })}`
        : anchor.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const chip = (a: CalActivity, detailed: boolean) => (
    <div
      key={a.id}
      onClick={() => openModal(a)}
      title={`${a.subject ?? a.type}${a.dealTitle ? ` · ${a.dealTitle}` : ""}${a.actor ? ` · ${a.actor.split("@")[0]}` : ""}`}
      style={{
        display: "flex",
        alignItems: detailed ? "center" : "baseline",
        gap: 6,
        fontSize: detailed ? 14 : 12,
        padding: detailed ? "8px 10px" : "2px 6px",
        borderRadius: 7,
        marginBottom: 3,
        cursor: "pointer",
        background: a.done ? "transparent" : isPast(a) ? "rgba(224,72,72,0.14)" : "var(--surface-2)",
        opacity: a.done ? 0.45 : 1,
        overflow: "hidden",
      }}
    >
      <span style={{ flexShrink: 0 }}>{TYPE_ICON[a.type] ?? "•"}</span>
      <span style={{ color: "var(--text-3)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {isAllDayIso(a.dueAt) ? "All day" : fmtTime(a.dueAt)}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textDecoration: a.done ? "line-through" : "none",
          fontWeight: 600,
          minWidth: 0,
        }}
      >
        {a.subject ?? a.type}
      </span>
      {detailed && (
        <>
          {a.contactName && (
            <span style={{ color: "var(--text-3)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.contactName}
            </span>
          )}
          {isAdmin && a.actor && (
            <span className="chip stage" style={{ flexShrink: 0, fontSize: 11.5 }}>{a.actor.split("@")[0]}</span>
          )}
          {!a.done && a.dealId && (
            <button
              className="btn ghost"
              style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 12.5, flexShrink: 0 }}
              disabled={saving}
              onClick={(e) => {
                e.stopPropagation();
                void markDone(a);
              }}
            >
              ✓ Done
            </button>
          )}
        </>
      )}
    </div>
  );

  if (error) return <div className="viewsub">Couldn’t load the calendar: {error}</div>;

  const weekDays = Array.from({ length: 7 }, (_, i) => new Date(weekStart(view === "month" ? new Date(anchor.getFullYear(), anchor.getMonth(), 1) : anchor).getTime() + i * DAY_MS));

  return (
    <>
      <h2 className="viewtitle">Calendar</h2>
      <div className="viewsub">Scheduled activities{isAdmin ? " · team-wide" : " · yours"}</div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        <div className="range-toggle" style={{ marginBottom: 0 }}>
          {(["month", "week", "day"] as CalView[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn ghost" style={{ padding: "7px 12px" }} onClick={() => step(-1)}>←</button>
        <button className="btn ghost" style={{ padding: "7px 12px" }} onClick={() => setAnchor(new Date())}>Today</button>
        <button className="btn ghost" style={{ padding: "7px 12px" }} onClick={() => step(1)}>→</button>
        <b style={{ fontSize: 16 }}>{label}</b>
        {isAdmin && (
          <select
            className="vmsel"
            style={{ width: "auto", marginLeft: "auto" }}
            value={repFilter}
            onChange={(e) => setRepFilter(e.target.value)}
          >
            <option value="all">Whole team</option>
            {OWNERS.map((o) => (
              <option key={o.id} value={String(o.id)}>{o.label}</option>
            ))}
          </select>
        )}
      </div>

      {view === "month" && (
        <div className="card" style={{ padding: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.06em", color: "var(--text-3)", textTransform: "uppercase", padding: "4px 6px" }}>
                {d}
              </div>
            ))}
            {Array.from({ length: 42 }, (_, i) => {
              const d = new Date(range.start.getTime() + i * DAY_MS);
              const k = dayKey(d);
              const inMonth = d.getMonth() === anchor.getMonth();
              const items = byDay.get(k) ?? [];
              return (
                <div
                  key={i}
                  onClick={() => {
                    setAnchor(d);
                    setView("day");
                  }}
                  style={{
                    minHeight: 92,
                    borderRadius: 8,
                    padding: "4px 5px",
                    background: k === todayKey ? "var(--accent-2-soft)" : "var(--surface-1)",
                    opacity: inMonth ? 1 : 0.4,
                    cursor: "pointer",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: k === todayKey ? 800 : 600, color: k === todayKey ? "var(--accent-2)" : "var(--text-3)", marginBottom: 3 }}>
                    {d.getDate()}
                  </div>
                  {items.slice(0, 3).map((a) => chip(a, false))}
                  {items.length > 3 && (
                    <div style={{ fontSize: 11, color: "var(--text-3)", paddingLeft: 4 }}>+{items.length - 3} more</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "week" && (
        <div className="card" style={{ padding: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
            {weekDays.map((d) => {
              const k = dayKey(d);
              const items = byDay.get(k) ?? [];
              return (
                <div key={k} style={{ minWidth: 0 }}>
                  <div
                    onClick={() => {
                      setAnchor(d);
                      setView("day");
                    }}
                    style={{
                      fontSize: 12.5,
                      fontWeight: 750,
                      color: k === todayKey ? "var(--accent-2)" : "var(--text-2)",
                      padding: "2px 4px 8px",
                      cursor: "pointer",
                    }}
                  >
                    {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
                  </div>
                  {items.length === 0 && <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "0 4px" }}>—</div>}
                  {items.map((a) => chip(a, false))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "day" && (
        <div className="card" style={{ maxWidth: 720 }}>
          {(byDay.get(dayKey(anchor)) ?? []).length === 0 && (
            <div style={{ color: "var(--text-3)", fontSize: 14 }}>Nothing scheduled this day. 🎉</div>
          )}
          {(byDay.get(dayKey(anchor)) ?? []).map((a) => chip(a, true))}
        </div>
      )}

      {modalAct && (
        <div className="modal-backdrop" onClick={() => setModalAct(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: "90%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 20 }}>{TYPE_ICON[modalAct.type] ?? "•"}</span>
              <b style={{ fontSize: 16 }}>{modalAct.subject ?? modalAct.type}</b>
            </div>
            {(modalAct.dealTitle || modalAct.contactName) && (
              <div className="viewsub" style={{ marginTop: 0 }}>
                {modalAct.dealTitle}{modalAct.contactName ? ` · ${modalAct.contactName}` : ""}
              </div>
            )}

            <div style={{ display: "grid", gap: 8, margin: "14px 0" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-3)" }}>Reschedule</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="date" className="vmsel" value={edDate} onChange={(e) => setEdDate(e.target.value)} style={{ flex: 1 }} />
                <input type="time" className="vmsel" value={edTime} onChange={(e) => setEdTime(e.target.value)} style={{ width: 120 }} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>Leave the time blank for an all-day activity.</div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={!edDate || saving} onClick={reschedule}>
                {saving ? "Saving…" : "Save"}
              </button>
              {modalAct.dealId && (
                <button className="btn" onClick={() => router.push(`/crm/deal/${modalAct.dealId}`)}>
                  View deal in CRM →
                </button>
              )}
              {!modalAct.done && modalAct.dealId && (
                <button className="btn ghost" disabled={saving} onClick={async () => { await markDone(modalAct); setModalAct(null); }}>
                  ✓ Mark done
                </button>
              )}
              <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => setModalAct(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
