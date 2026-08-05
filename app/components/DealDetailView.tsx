"use client";

import { useCallback, useEffect, useState } from "react";

interface DealData {
  deal: any;
  timeline: { id?: string; kind: string; at: string | null; title: string; body: string | null; actor: string | null; done: boolean; due: string | null }[];
  stages: { id: string; name: string; crm_pipelines: { name: string } | null }[];
  sprints: { id: string; name: string; owner: string }[];
  dealSprintIds: string[];
  sprintOwners: string[];
}

const KIND_ICON: Record<string, string> = {
  call: "📞", sms: "💬", email: "✉️", task: "📋", note: "📝", meeting: "📅", system: "⚙️",
};

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function DealDetailView({ dealId }: { dealId: string }) {
  const [data, setData] = useState<DealData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const [schedType, setSchedType] = useState("call");
  const [schedSubject, setSchedSubject] = useState("");
  const [schedDue, setSchedDue] = useState("");
  const [sprintPick, setSprintPick] = useState("");
  const [callHint, setCallHint] = useState(false);
  const [newSprintName, setNewSprintName] = useState("");
  const [newSprintOwner, setNewSprintOwner] = useState("");

  const load = useCallback(
    () =>
      fetch(`/api/crm/deal?id=${dealId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(setData)
        .catch((e) => setError(String(e))),
    [dealId]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const update = async (fields: Record<string, unknown>) => {
    setSaving(true);
    setWarn(null);
    const r = await fetch("/api/crm/deal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: dealId, ...fields }),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      if (d.writeThroughError) {
        setWarn(`Saved here — Pipedrive write-through failed (${d.writeThroughError}). It will match after cutover or a re-sync.`);
      }
      await load();
    } else {
      setWarn("Update failed");
    }
    setSaving(false);
  };

  if (error) return <div className="viewsub">Couldn’t load deal: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const d = data.deal;
  const contact = d.crm_contacts;
  const phones = (contact?.phones ?? []) as { value: string; e164?: string; primary?: boolean }[];
  const emails = (contact?.emails ?? []) as { value: string; primary?: boolean }[];

  return (
    <>
      <div className="viewsub" style={{ marginBottom: 6 }}>
        <a href="/crm" style={{ color: "var(--text-3)", textDecoration: "none" }}>← All deals</a>
      </div>
      <h2 className="viewtitle">{d.title}</h2>
      <div className="viewsub">
        {d.crm_stages?.crm_pipelines?.name} ▸ {d.crm_stages?.name ?? "—"} · {d.status}
        {d.value_cents != null && <> · ${Math.round(d.value_cents / 100).toLocaleString()}</>}
      </div>
      {warn && <div className="viewsub" style={{ color: "var(--warn)" }}>{warn}</div>}

      <div className="split" style={{ marginTop: 0 }}>
        <div>
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="panel-h">Actions</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                className="vmsel"
                style={{ width: "auto" }}
                value={d.stage_id ?? ""}
                onChange={(e) => update({ stageId: e.target.value })}
                disabled={saving}
              >
                {data.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.crm_pipelines?.name} ▸ {s.name}
                  </option>
                ))}
              </select>
              <select
                className="vmsel"
                style={{ width: "auto" }}
                value={d.owner_pipedrive_id ?? ""}
                onChange={(e) => update({ ownerPipedriveId: e.target.value })}
                disabled={saving}
                title="Deal owner"
              >
                <option value="" disabled>Owner…</option>
                <option value="24081760">Parker</option>
                <option value="24391245">Jackson</option>
                <option value="24723797">Cainen</option>
                <option value="23851101">Gabi</option>
              </select>
              {d.status === "open" ? (
                <>
                  <button className="btn ghost" style={{ padding: "8px 13px", fontSize: 14 }} onClick={() => update({ status: "won" })} disabled={saving}>
                    ✓ Won
                  </button>
                  <button className="btn ghost" style={{ padding: "8px 13px", fontSize: 14 }} onClick={() => update({ status: "lost" })} disabled={saving}>
                    ✗ Lost
                  </button>
                </>
              ) : (
                <button className="btn ghost" style={{ padding: "8px 13px", fontSize: 14 }} onClick={() => update({ status: "open" })} disabled={saving}>
                  Reopen
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input
                className="vmsel"
                style={{ flex: 1 }}
                placeholder="Add a note… (saves here + Pipedrive)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && note.trim()) {
                    void update({ note });
                    setNote("");
                  }
                }}
              />
              <button
                className="btn primary"
                style={{ padding: "8px 14px", fontSize: 14 }}
                disabled={!note.trim() || saving}
                onClick={() => {
                  void update({ note });
                  setNote("");
                }}
              >
                Add note
              </button>
            </div>

            <div className="panel-h" style={{ marginTop: 16 }}>Schedule activity</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select className="vmsel" style={{ width: "auto" }} value={schedType} onChange={(e) => setSchedType(e.target.value)}>
                <option value="call">📞 Call</option>
                <option value="task">📋 Task</option>
                <option value="meeting">📅 Meeting</option>
                <option value="email">✉️ Email</option>
              </select>
              <input
                className="vmsel"
                style={{ flex: 1, minWidth: 160 }}
                placeholder="What needs to happen?"
                value={schedSubject}
                onChange={(e) => setSchedSubject(e.target.value)}
              />
              <input
                type="datetime-local"
                className="vmsel"
                style={{ width: "auto" }}
                value={schedDue}
                onChange={(e) => setSchedDue(e.target.value)}
              />
              <button
                className="btn primary"
                style={{ padding: "8px 14px", fontSize: 14 }}
                disabled={!schedSubject.trim() || saving}
                onClick={() => {
                  void update({
                    activity: {
                      type: schedType,
                      subject: schedSubject,
                      dueAt: schedDue ? new Date(schedDue).toISOString() : null,
                    },
                  });
                  setSchedSubject("");
                  setSchedDue("");
                }}
              >
                Schedule
              </button>
            </div>

            <div className="panel-h" style={{ marginTop: 16 }}>Call sprint</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select className="vmsel" style={{ width: "auto", minWidth: 180 }} value={sprintPick} onChange={(e) => setSprintPick(e.target.value)}>
                <option value="">Add to sprint…</option>
                {data.sprints.map((s) => (
                  <option key={s.id} value={s.id} disabled={data.dealSprintIds.includes(s.id)}>
                    {s.name} · {s.owner.split("@")[0]}{data.dealSprintIds.includes(s.id) ? " ✓ (already in)" : ""}
                  </option>
                ))}
                <option value="__new">＋ New sprint…</option>
              </select>
              {sprintPick === "__new" && (
                <>
                  <input
                    className="vmsel"
                    style={{ width: "auto" }}
                    placeholder="Sprint name"
                    value={newSprintName}
                    onChange={(e) => setNewSprintName(e.target.value)}
                  />
                  <select className="vmsel" style={{ width: "auto" }} value={newSprintOwner} onChange={(e) => setNewSprintOwner(e.target.value)}>
                    <option value="">Rep…</option>
                    {data.sprintOwners.map((o) => (
                      <option key={o} value={o}>{o.split("@")[0]}</option>
                    ))}
                  </select>
                </>
              )}
              <button
                className="btn ghost"
                style={{ padding: "8px 13px", fontSize: 14 }}
                disabled={
                  saving ||
                  (sprintPick === "__new" ? !newSprintName.trim() || !newSprintOwner : !sprintPick)
                }
                onClick={() => {
                  void update({
                    sprint:
                      sprintPick === "__new"
                        ? { name: newSprintName, owner: newSprintOwner }
                        : { sprintId: sprintPick },
                  });
                  setSprintPick("");
                  setNewSprintName("");
                }}
              >
                Add to sprint
              </button>
              {data.dealSprintIds.length > 0 && (
                <span style={{ fontSize: 13, color: "var(--text-3)" }}>
                  In {data.dealSprintIds.length} sprint{data.dealSprintIds.length === 1 ? "" : "s"} — shows in that rep’s dialer
                </span>
              )}
            </div>
          </div>

          {(() => {
            const upcoming = data.timeline
              .filter((t) => t.id && t.due && !t.done && t.kind !== "system")
              .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
            if (upcoming.length === 0) return null;
            return (
              <div className="card" style={{ marginBottom: 18 }}>
                <div className="panel-h">Upcoming</div>
                {upcoming.map((t) => (
                  <div className="stmt-row" key={t.id} style={{ alignItems: "center" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                      <span>{KIND_ICON[t.kind] ?? "•"}</span>
                      <b style={{ fontSize: 14 }}>{t.title}</b>
                      <span style={{ fontSize: 13, color: Date.parse(t.due!) < Date.now() ? "var(--crit)" : "var(--text-3)" }}>
                        {Date.parse(t.due!) < Date.now() ? "overdue · " : "due "}
                        {fmtWhen(t.due)}
                      </span>
                    </div>
                    <button
                      className="btn ghost"
                      style={{ padding: "4px 10px", fontSize: 13, flexShrink: 0 }}
                      disabled={saving}
                      onClick={() => update({ completeActivityId: t.id })}
                    >
                      ✓ Done
                    </button>
                  </div>
                ))}
              </div>
            );
          })()}

          <div className="card">
            <div className="panel-h">Timeline</div>
            {data.timeline.length === 0 && (
              <div style={{ color: "var(--text-3)", fontSize: 14 }}>No activity yet.</div>
            )}
            {/* Pending scheduled items live in Upcoming, not the timeline —
                they land here once completed. */}
            {data.timeline.filter((t) => !(t.due && !t.done)).map((t, i) => (
              <div className="stmt-row" style={{ alignItems: "flex-start" }} key={i}>
                <div style={{ display: "flex", gap: 8 }}>
                  <span>{KIND_ICON[t.kind] ?? "•"}</span>
                  <div>
                    <b style={{ fontSize: 14 }}>{t.title}</b>
                    {t.body && (
                      <div style={{ fontSize: 13.5, color: "var(--text-2)", maxWidth: 480 }}>{t.body}</div>
                    )}
                    {t.actor && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{t.actor}</div>}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-3)", flexShrink: 0, marginLeft: 10 }}>
                  {fmtWhen(t.at)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="panel-h">Contact</div>
          {contact ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{contact.name}</div>
              {contact.org_name && <div style={{ color: "var(--text-2)", fontSize: 14 }}>{contact.org_name}</div>}
              <div style={{ marginTop: 10 }}>
                {phones.map((p, i) => {
                  const num = p.e164 ?? p.value;
                  return (
                    <div key={i} style={{ fontSize: 14, fontVariantNumeric: "tabular-nums", padding: "3px 0" }}>
                      📞{" "}
                      <a
                        href={`tel:${num}`}
                        style={{ color: "var(--text-1)", textDecorationColor: "var(--text-3)" }}
                        title={callHint ? "Number copied — paste in the Quo web tab" : "Call via Quo"}
                        onClick={(e) => {
                          // Same per-machine setting as the dialer: web mode
                          // hands off via clipboard (Quo web has no dial URL).
                          if (localStorage.getItem("dialMethod") === "web") {
                            e.preventDefault();
                            void navigator.clipboard?.writeText(num).catch(() => {});
                            window.open("https://my.quo.com", "quo-web");
                            setCallHint(true);
                            setTimeout(() => setCallHint(false), 6000);
                          }
                        }}
                      >
                        {num}
                      </a>
                      {p.primary && <span style={{ fontSize: 11, color: "var(--text-3)" }}> · primary</span>}
                    </div>
                  );
                })}
                {callHint && (
                  <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>
                    📋 Number copied — paste into the Quo web dialer (⌘V)
                  </div>
                )}
                {emails.map((e, i) => (
                  <div key={i} style={{ fontSize: 14, padding: "3px 0", color: "var(--text-2)" }}>
                    ✉️{" "}
                    <a
                      href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(e.value)}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--text-2)", textDecorationColor: "var(--text-3)" }}
                      title="Compose in Gmail"
                    >
                      {e.value}
                    </a>
                  </div>
                ))}
                {phones.length === 0 && emails.length === 0 && (
                  <div style={{ color: "var(--text-3)", fontSize: 14 }}>No contact details.</div>
                )}
              </div>
            </>
          ) : (
            <div style={{ color: "var(--text-3)", fontSize: 14 }}>No linked contact.</div>
          )}
          <div className="panel-h" style={{ marginTop: 16 }}>Record</div>
          <div style={{ fontSize: 13.5, color: "var(--text-3)", lineHeight: 1.8 }}>
            Created {fmtWhen(d.pd_add_time ?? d.created_at)}<br />
            Stage changed {fmtWhen(d.stage_changed_at)}<br />
            Last activity {fmtWhen(d.last_activity_at)}<br />
            Pipedrive #{d.pipedrive_deal_id ?? "—"}
          </div>
          {emails[0]?.value && <KlaviyoActivity email={emails[0].value} />}
        </div>
      </div>
    </>
  );
}

// ── Klaviyo marketing signals ───────────────────────────────────────────────

type SignalKind = "cart" | "build" | "order" | "view" | "email" | "msg" | "other";

/** Cart adds + saved builds are the buying-mode leading indicators. */
function eventKind(metric: string): SignalKind {
  const s = metric.toLowerCase();
  if (/(add|added).*cart|checkout started|started checkout/.test(s)) return "cart";
  if (/saved.*build|build.*saved/.test(s)) return "build";
  if (/placed order|ordered product|fulfilled/.test(s)) return "order";
  if (/viewed|active on site/.test(s)) return "view";
  if (/email|bounc|unsubscribe|spam/.test(s)) return "email";
  if (/whatsapp|sms|message/.test(s)) return "msg";
  return "other";
}

const SIGNAL_ICON: Record<SignalKind, string> = {
  cart: "🛒",
  build: "🏗",
  order: "💰",
  view: "👀",
  email: "✉️",
  msg: "💬",
  other: "⚡",
};

const isBuying = (k: SignalKind) => k === "cart" || k === "build";

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  const days = Math.round(h / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function KlaviyoActivity({ email }: { email: string }) {
  const [events, setEvents] = useState<{ metric: string; at: string; detail: Record<string, unknown> }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setEvents(null);
    setFailed(false);
    fetch(`/api/crm/contact-events?email=${encodeURIComponent(email)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setFailed(true));
  }, [email]);

  const shown = events ? (showAll ? events : events.slice(0, 15)) : [];
  // Buying-mode banner: freshest cart/saved-build signal in the last 14 days.
  const freshBuying = (events ?? []).find(
    (e) => isBuying(eventKind(e.metric)) && Date.now() - Date.parse(e.at) < 14 * 86_400_000
  );

  return (
    <>
      <div className="panel-h" style={{ marginTop: 16 }}>Marketing signals</div>
      {events === null && !failed && <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>Loading Klaviyo history…</div>}
      {failed && <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>Klaviyo unavailable right now.</div>}
      {events !== null && events.length === 0 && (
        <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>No Klaviyo events for {email}.</div>
      )}
      {freshBuying && (
        <div
          style={{
            background: "var(--accent-soft)",
            border: "1px solid rgba(217, 91, 49, 0.45)",
            borderRadius: 10,
            padding: "9px 12px",
            fontSize: 13.5,
            fontWeight: 700,
            marginBottom: 10,
          }}
        >
          {SIGNAL_ICON[eventKind(freshBuying.metric)]} Buying mode — {freshBuying.metric} {relTime(freshBuying.at)}
        </div>
      )}
      {shown.length > 0 && (
        <div style={{ maxHeight: 340, overflowY: "auto" }}>
          {shown.map((e, i) => {
            const kind = eventKind(e.metric);
            const buying = isBuying(kind);
            const detail = Object.values(e.detail ?? {}).join(" · ");
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "6px 8px",
                  fontSize: 13.5,
                  borderRadius: 8,
                  marginBottom: 2,
                  background: buying ? "var(--accent-soft)" : "transparent",
                  boxShadow: buying ? "inset 2px 0 0 var(--accent)" : "none",
                }}
              >
                <span style={{ flexShrink: 0 }}>{SIGNAL_ICON[kind]}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: buying ? 750 : 600, color: "var(--text-1)" }}>{e.metric}</span>
                  {detail && (
                    <span style={{ display: "block", color: "var(--text-3)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {detail}
                    </span>
                  )}
                </span>
                <span style={{ color: "var(--text-3)", fontSize: 12, whiteSpace: "nowrap" }}>{relTime(e.at)}</span>
              </div>
            );
          })}
          {events && events.length > 15 && !showAll && (
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center", padding: "6px 0", fontSize: 13 }} onClick={() => setShowAll(true)}>
              Show all {events.length} events
            </button>
          )}
        </div>
      )}
    </>
  );
}
