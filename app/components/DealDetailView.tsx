"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newOutboundCall, setOutboundHandler } from "./phoneClient";

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

          <CommBar
            dealId={d.id}
            pdDealId={d.pipedrive_deal_id ?? null}
            contact={contact ? { id: contact.id, name: contact.name, firstName: contact.first_name } : null}
            phone={phones.find((p) => p.primary)?.e164 ?? phones[0]?.e164 ?? phones[0]?.value ?? null}
            email={emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? null}
            onLogged={load}
          />

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
                <AddContactDetail contactId={contact.id} onSaved={load} />
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
          {emails[0]?.value && (
            <KlaviyoActivity
              email={emails[0].value}
              contactId={contact?.id ?? null}
              knownPhones={phones.map((p) => p.e164 ?? p.value)}
              onSaved={load}
            />
          )}
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

const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);

/** URLs inside event text: click copies the link (works identically in the
 * browser and the companion webview, which can't open external tabs). */
function Linkify({ text }: { text: string }) {
  const parts = String(text).split(/(https?:\/\/[^\s"',]+)/g);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <span key={i}>
            <a
              href={p}
              style={{ color: "var(--accent-2)", wordBreak: "break-all", cursor: "copy" }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void navigator.clipboard?.writeText(p).catch(() => {});
                setCopiedIdx(i);
                setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 2000);
              }}
              title="Click to copy the link"
            >
              {p}
            </a>
            {copiedIdx === i && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 11,
                  fontWeight: 800,
                  color: "var(--good)",
                  background: "rgba(76, 196, 76, 0.14)",
                  borderRadius: 999,
                  padding: "1px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                ✓ Link copied
              </span>
            )}
          </span>
        ) : (
          p
        )
      )}
    </>
  );
}

function KlaviyoActivity({
  email,
  contactId,
  knownPhones,
  onSaved,
}: {
  email: string;
  contactId: string | null;
  knownPhones: string[];
  onSaved: () => void;
}) {
  const [events, setEvents] = useState<{ metric: string; at: string; detail: Record<string, unknown> }[] | null>(null);
  const [profilePhones, setProfilePhones] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (i: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  useEffect(() => {
    setEvents(null);
    setFailed(false);
    fetch(`/api/crm/contact-events?email=${encodeURIComponent(email)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setEvents(d.events ?? []);
        setProfilePhones(d.profile?.phones ?? []);
      })
      .catch(() => setFailed(true));
  }, [email]);

  // Phones Klaviyo knows that the CRM contact is missing.
  const known = new Set(knownPhones.map(last10));
  const suggestions = profilePhones.filter((p) => last10(p).length === 10 && !known.has(last10(p)));

  const addSuggested = async (phone: string) => {
    if (!contactId) return;
    setAdding(phone);
    const r = await fetch("/api/crm/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, phone, source: "klaviyo" }),
    }).catch(() => null);
    setAdding(null);
    if (r?.ok) onSaved();
  };

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
      {contactId &&
        suggestions.map((p) => (
          <div
            key={p}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--accent-2-soft)",
              border: "1px solid rgba(196,154,108,0.35)",
              borderRadius: 10,
              padding: "7px 11px",
              fontSize: 13.5,
              marginBottom: 8,
            }}
          >
            📱 Klaviyo has <b style={{ fontVariantNumeric: "tabular-nums" }}>{p}</b>
            <button
              className="btn primary"
              style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12.5 }}
              disabled={adding === p}
              onClick={() => addSuggested(p)}
            >
              {adding === p ? "…" : "+ Add to contact"}
            </button>
          </div>
        ))}
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
        <div style={{ maxHeight: 340, overflowY: "auto", overflowX: "hidden" }}>
          {shown.map((e, i) => {
            const kind = eventKind(e.metric);
            const buying = isBuying(kind);
            const entries = Object.entries(e.detail ?? {});
            const detail = entries.map(([, v]) => String(v)).join(" · ");
            const isOpen = expanded.has(i);
            return (
              <div
                key={i}
                onClick={() => toggleExpanded(i)}
                title={isOpen ? undefined : "Click to expand"}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "6px 8px",
                  fontSize: 13.5,
                  borderRadius: 8,
                  marginBottom: 2,
                  cursor: "pointer",
                  background: buying ? "var(--accent-soft)" : isOpen ? "var(--surface-2)" : "transparent",
                  boxShadow: buying ? "inset 2px 0 0 var(--accent)" : "none",
                }}
              >
                <span style={{ flexShrink: 0 }}>{SIGNAL_ICON[kind]}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: buying ? 750 : 600, color: "var(--text-1)" }}>{e.metric}</span>
                  {!isOpen && detail && (
                    <span style={{ display: "block", color: "var(--text-3)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {detail}
                    </span>
                  )}
                  {isOpen && (
                    <span style={{ display: "block", marginTop: 4 }}>
                      {entries.length === 0 && (
                        <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>No event details.</span>
                      )}
                      {entries.map(([k, v]) => (
                        <span key={k} style={{ display: "block", fontSize: 12.5, color: "var(--text-2)", padding: "1px 0", wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                          <span style={{ color: "var(--text-3)" }}>{k}: </span>
                          <Linkify text={String(v)} />
                        </span>
                      ))}
                      <span style={{ display: "block", fontSize: 11.5, color: "var(--text-3)", marginTop: 3 }}>
                        {new Date(e.at).toLocaleString()}
                      </span>
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

/** Inline "+ add phone / email" for a contact — CRM-first, Pipedrive via outbox. */
function AddContactDetail({ contactId, onSaved }: { contactId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (payload: { phone?: string; email?: string }) => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/crm/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, ...payload }),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    setBusy(false);
    if (r?.ok) {
      setPhone("");
      setEmail("");
      setOpen(false);
      onSaved();
    } else {
      setErr(d?.error ?? "Save failed");
    }
  };

  if (!open) {
    return (
      <button
        className="btn ghost"
        style={{ padding: "4px 12px", fontSize: 12.5, marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        ＋ Add phone / email
      </button>
    );
  }
  return (
    <div style={{ marginTop: 10, display: "grid", gap: 6, maxWidth: 320 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="vmsel"
          placeholder="Phone number…"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && phone.trim() && save({ phone: phone.trim() })}
        />
        <button
          className="btn primary"
          style={{ padding: "6px 12px", fontSize: 13 }}
          disabled={!phone.trim() || busy}
          onClick={() => save({ phone: phone.trim() })}
        >
          Add
        </button>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="vmsel"
          placeholder="Email address…"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && email.trim() && save({ email: email.trim() })}
        />
        <button
          className="btn primary"
          style={{ padding: "6px 12px", fontSize: 13 }}
          disabled={!email.trim() || busy}
          onClick={() => save({ email: email.trim() })}
        >
          Add
        </button>
      </div>
      {err && <div style={{ color: "var(--crit)", fontSize: 12.5 }}>{err}</div>}
      <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

// ── Comm bar: Call / Text / WhatsApp / Email without leaving the deal ───────

interface Macro {
  id: string;
  channel: "sms" | "whatsapp" | "email" | "any";
  name: string;
  subject: string | null;
  body: string;
}
interface Asset {
  id: string;
  kind: "url" | "media";
  name: string;
  url: string;
}

type CommChannel = "sms" | "whatsapp" | "email";

function CommBar({
  dealId,
  pdDealId,
  contact,
  phone,
  email,
  onLogged,
}: {
  dealId: string;
  pdDealId: number | null;
  contact: { id: string; name: string; firstName: string | null } | null;
  phone: string | null;
  email: string | null;
  onLogged: () => void;
}) {
  const [channel, setChannel] = useState<CommChannel | null>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [waProfileId, setWaProfileId] = useState<string | null | "missing">(null);
  // Browser-mode call state (Telnyx singleton)
  const [callState, setCallState] = useState<string | null>(null);
  const callRef = useRef<any>(null);

  // ── Disposition flow — same shape as the dialer's ──
  const dialStartedAtRef = useRef<string | null>(null);
  const [awaitingDispo, setAwaitingDispo] = useState(false);
  const [pendingDispo, setPendingDispo] = useState<string | null>(null);
  const [dispoNote, setDispoNote] = useState("");
  const [nextType, setNextType] = useState("call");
  const [customDue, setCustomDue] = useState("");
  const [showCustomDue, setShowCustomDue] = useState(false);

  const DISPOSITIONS: [string, string][] = [
    ["connected", "✅ Connected"],
    ["vm_dropped", "🎙 VM left"],
    ["bad_number", "🚫 Bad number"],
    ["callback", "📅 Callback set"],
    ["confirmation", "📋 Confirmation call"],
  ];
  const FOLLOW_UP_SUBJECT: Record<string, string> = {
    connected: "Continue conversation",
    vm_dropped: "Follow up — voicemail left",
    callback: "Callback requested",
    bad_number: "Follow up — fix number first",
    confirmation: "Confirmation follow-up",
  };
  const followUpAt = (days: number): string => {
    const dt = new Date();
    dt.setDate(dt.getDate() + days);
    dt.setHours(9, 0, 0, 0);
    return dt.toISOString();
  };

  useEffect(() => {
    fetch("/api/crm/comm-library")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setMacros(d.macros ?? []);
        setAssets(d.assets ?? []);
      })
      .catch(() => {});
    return () => setOutboundHandler(null);
  }, []);

  // Resolve the Klaviyo profile once the WhatsApp composer opens.
  useEffect(() => {
    if (channel !== "whatsapp" || waProfileId || !email) return;
    fetch(`/api/crm/contact-events?email=${encodeURIComponent(email)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWaProfileId(d?.profile?.id ?? "missing"))
      .catch(() => setWaProfileId("missing"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, email]);

  const renderTemplate = (text: string) =>
    text
      .replaceAll("{{name}}", contact?.name?.trim() ?? "")
      .replaceAll("{{first_name}}", contact?.firstName ?? contact?.name?.split(" ")[0] ?? "");

  const applyMacro = (id: string) => {
    const m = macros.find((x) => x.id === id);
    if (!m) return;
    setBody(renderTemplate(m.body));
    if (m.subject && channel === "email") setSubject(renderTemplate(m.subject));
  };

  const appendAsset = (id: string) => {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    setBody((b) => (b ? `${b.trimEnd()} ${a.url}` : a.url));
  };

  const startCall = () => {
    if (!phone || awaitingDispo) return;
    dialStartedAtRef.current = new Date().toISOString();
    // Attempt log drives pool cooldown/fairness, same as the dialer.
    if (pdDealId) {
      void fetch("/api/dialer/attempt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: pdDealId, crmDealId: dealId }),
      }).catch(() => {});
    }
    const method = localStorage.getItem("dialMethod") ?? "desktop";
    if (method === "browser") {
      setCallState("connecting");
      setOutboundHandler((c: any, s: string) => {
        callRef.current = c;
        if (s === "ringing" || s === "trying" || s === "requesting") setCallState("ringing");
        if (s === "active") setCallState("active");
        if (s === "hangup" || s === "destroy") {
          setCallState(null);
          callRef.current = null;
          setAwaitingDispo(true);
        }
      });
      newOutboundCall(phone)
        .then((c) => {
          callRef.current = c;
          setCallState("ringing");
        })
        .catch((e) => setCallState(`error: ${e instanceof Error ? e.message : e}`));
    } else {
      // Call happens in Quo — log the outcome here when it wraps.
      if (method === "web") {
        void navigator.clipboard?.writeText(phone).catch(() => {});
        window.open("https://my.quo.com", "quo-web");
      } else if (window.__TAURI__) {
        void window.__TAURI__.core.invoke("open_tel", { url: `tel:${phone}` }).catch(() => {});
      } else {
        window.location.href = `tel:${phone}`;
      }
      setAwaitingDispo(true);
    }
  };

  const endCall = () => {
    try {
      callRef.current?.hangup();
    } catch {}
    setCallState(null);
    setAwaitingDispo(true);
  };

  const flashOk = (msg: string) => {
    setOk(msg);
    setTimeout(() => setOk(null), 3000);
  };

  /** Same retry contract as the dialer: 202 until the webhook lands. */
  const completeDispo = async (dueAt: string | null) => {
    const dispo = pendingDispo;
    if (!dispo || !phone || !dialStartedAtRef.current) return;
    const payload = {
      dealId: pdDealId ?? undefined,
      crmDealId: dealId,
      phone,
      disposition: dispo,
      dialStartedAt: dialStartedAtRef.current,
      next: dueAt ? { type: nextType, subject: FOLLOW_UP_SUBJECT[dispo] ?? "Follow up", dueAt } : null,
      note: dispoNote.trim() || null,
    };
    setPendingDispo(null);
    setAwaitingDispo(false);
    setShowCustomDue(false);
    setCustomDue("");
    setDispoNote("");
    flashOk("Logging…");
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch("/api/dialer/disposition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, final: attempt === 3 }),
      }).catch(() => null);
      if (r && r.status !== 202) break;
      await new Promise((res) => setTimeout(res, 4000));
    }
    flashOk("Call logged ✓");
    onLogged();
  };

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setErr(null);
    try {
      let r: Response | null = null;
      if (channel === "sms") {
        r = await fetch("/api/texts/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phone, body: text, crmDealId: dealId, contactId: contact?.id }),
        });
      } else if (channel === "whatsapp") {
        if (!waProfileId || waProfileId === "missing") throw new Error("No Klaviyo profile for this contact");
        r = await fetch("/api/crm/whatsapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: waProfileId, message: text, dealId, contactId: contact?.id }),
        });
      } else if (channel === "email") {
        if (!subject.trim()) throw new Error("Subject required");
        r = await fetch("/api/gmail/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: email, subject: subject.trim(), body: text, dealId, contactId: contact?.id }),
        });
      }
      const d = await r?.json().catch(() => ({}));
      if (!r?.ok || d?.error) throw new Error(d?.error ?? `HTTP ${r?.status}`);
      setBody("");
      setSubject("");
      setChannel(null);
      flashOk("Sent ✓");
      onLogged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const macrosFor = macros.filter((m) => m.channel === channel || m.channel === "any");
  const urls = assets.filter((a) => a.kind === "url");
  const media = assets.filter((a) => a.kind === "media");

  const btnStyle: React.CSSProperties = { justifyContent: "center", width: "100%" };

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Floating buttons — no card, low visual weight. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {callState === null ? (
          <button className="btn" style={btnStyle} disabled={!phone || awaitingDispo} title={phone ?? "No phone on contact"} onClick={startCall}>
            📞 Call
          </button>
        ) : callState.startsWith("error") ? (
          <button className="btn" style={{ ...btnStyle, color: "var(--crit)" }} onClick={() => setCallState(null)} title={callState}>
            📞 Failed — retry
          </button>
        ) : (
          <button className="btn" style={{ ...btnStyle, background: "var(--crit)", color: "#fff" }} onClick={endCall}>
            ⏹ {callState === "active" ? "On call" : "Ringing…"}
          </button>
        )}
        <button
          className={`btn ${channel === "sms" ? "primary" : ""}`}
          style={btnStyle}
          disabled={!phone}
          title={phone ?? "No phone on contact"}
          onClick={() => {
            setErr(null);
            setChannel((c) => (c === "sms" ? null : "sms"));
          }}
        >
          💬 Text
        </button>
        <button
          className={`btn ${channel === "whatsapp" ? "primary" : ""}`}
          style={btnStyle}
          disabled={!email}
          title={email ?? "Needs an email to find the Klaviyo profile"}
          onClick={() => {
            setErr(null);
            setChannel((c) => (c === "whatsapp" ? null : "whatsapp"));
          }}
        >
          🟢 WhatsApp
        </button>
        <button
          className={`btn ${channel === "email" ? "primary" : ""}`}
          style={btnStyle}
          disabled={!email}
          title={email ?? "No email on contact"}
          onClick={() => {
            setErr(null);
            setChannel((c) => (c === "email" ? null : "email"));
          }}
        >
          ✉️ Email
        </button>
      </div>
      {ok && <div style={{ color: "var(--good)", fontSize: 13.5, fontWeight: 700, marginTop: 8 }}>{ok}</div>}

      {/* Disposition — appears when a call wraps, same flow as the dialer. */}
      {awaitingDispo && !pendingDispo && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="panel-h">How did the call go?</div>
          <div className="dispo-row attn" style={{ display: "flex", marginTop: 0 }}>
            {DISPOSITIONS.map(([key, label]) => (
              <button key={key} className="btn" onClick={() => setPendingDispo(key)}>
                {label}
              </button>
            ))}
            <button className="btn ghost" onClick={() => setAwaitingDispo(false)} title="No disposition — the call still logs via webhook">
              Skip
            </button>
          </div>
        </div>
      )}
      {awaitingDispo && pendingDispo && (
        <div className="card" style={{ marginTop: 12 }}>
          <input
            className="vmsel"
            style={{ width: "100%", marginBottom: 8 }}
            placeholder="Add a note about this call… (optional, saves to the deal)"
            value={dispoNote}
            onChange={(e) => setDispoNote(e.target.value)}
          />
          <div className="dispo-row" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", marginTop: 0 }}>
            <span style={{ fontSize: 13.5, color: "var(--text-2)" }}>Next step?</span>
            <select className="vmsel" style={{ width: "auto", padding: "6px 8px", fontSize: 13.5 }} value={nextType} onChange={(e) => setNextType(e.target.value)}>
              <option value="call">📞 Call</option>
              <option value="task">📋 Task</option>
              <option value="email">✉️ Email</option>
              <option value="meeting">📅 Meeting</option>
            </select>
            <button className="btn" onClick={() => completeDispo(followUpAt(7))}>1 week</button>
            <button className="btn" onClick={() => completeDispo(followUpAt(14))}>2 weeks</button>
            <button className="btn" onClick={() => completeDispo(followUpAt(30))}>1 month</button>
            <button className="btn" onClick={() => setShowCustomDue((v) => !v)}>📅 Custom…</button>
            <button className="btn ghost" onClick={() => completeDispo(null)}>No follow-up</button>
          </div>
          {showCustomDue && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input
                type="datetime-local"
                className="vmsel"
                style={{ width: "auto" }}
                value={customDue}
                onChange={(e) => setCustomDue(e.target.value)}
              />
              <button
                className="btn primary"
                style={{ padding: "7px 14px", fontSize: 14 }}
                disabled={!customDue}
                onClick={() => completeDispo(new Date(customDue).toISOString())}
              >
                Schedule
              </button>
            </div>
          )}
        </div>
      )}

      {channel && (
        <div className="card" style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select className="vmsel" style={{ width: "auto", flex: 1, minWidth: 140 }} value="" onChange={(e) => e.target.value && applyMacro(e.target.value)}>
              <option value="">📋 Macro…</option>
              {macrosFor.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <select className="vmsel" style={{ width: "auto", flex: 1, minWidth: 140 }} value="" onChange={(e) => e.target.value && appendAsset(e.target.value)}>
              <option value="">🔗 URL asset…</option>
              {urls.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select className="vmsel" style={{ width: "auto", flex: 1, minWidth: 140 }} value="" onChange={(e) => e.target.value && appendAsset(e.target.value)}>
              <option value="">🖼 Media asset…</option>
              {media.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          {channel === "email" && (
            <input
              className="vmsel"
              placeholder="Subject…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          )}
          <textarea
            className="vmsel"
            rows={4}
            style={{ resize: "vertical" }}
            placeholder={
              channel === "sms"
                ? `Text ${phone}…`
                : channel === "whatsapp"
                  ? "WhatsApp message…"
                  : `Email ${email}…`
            }
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {channel === "whatsapp" && waProfileId === "missing" && (
            <div style={{ color: "var(--warn)", fontSize: 13 }}>
              No Klaviyo profile found for {email} — WhatsApp needs one.
            </div>
          )}
          {err && <div style={{ color: "var(--crit)", fontSize: 13 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={!body.trim() || sending} onClick={send}>
              {sending ? "Sending…" : `Send ${channel === "sms" ? "text" : channel === "whatsapp" ? "WhatsApp" : "email"}`}
            </button>
            <button className="btn ghost" onClick={() => setChannel(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
