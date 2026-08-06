"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { newOutboundCall, setOutboundHandler } from "./phoneClient";
import { INTERESTS } from "./interests";

interface DealData {
  deal: any;
  timeline: { id?: string; kind: string; at: string | null; title: string; body: string | null; actor: string | null; done: boolean; due: string | null }[];
  callStats: { dials: number; answered: number; talkS: number; inbound: number } | null;
  sources: { id: string; name: string }[];
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string; pipeline_id: string; crm_pipelines: { name: string } | null }[];
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

export function DealDetailView({ dealId, pdDealId, embedded }: { dealId?: string; pdDealId?: number; embedded?: boolean }) {
  const [data, setData] = useState<DealData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const [schedType, setSchedType] = useState("call");
  const [schedSubject, setSchedSubject] = useState("");
  const [schedDue, setSchedDue] = useState("");
  const [sprintPick, setSprintPick] = useState("");
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [newSprintName, setNewSprintName] = useState("");
  const [newSprintOwner, setNewSprintOwner] = useState("");
  // Upcoming-activity inline editor
  const [editAct, setEditAct] = useState<{ id: string; subject: string; type: string; due: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "note" | "schedule" | "sprint" | "lost" | "reopen" | "log">(null);
  const [logType, setLogType] = useState("call");
  const [logSubject, setLogSubject] = useState("");
  const [logNote, setLogNote] = useState("");
  const [logWhen, setLogWhen] = useState("");
  const [depositFollow, setDepositFollow] = useState(false); // schedule modal opened by the Deposit flow
  const [lostReason, setLostReason] = useState("");
  const [reopenPipe, setReopenPipe] = useState("");
  const [reopenStage, setReopenStage] = useState("");
  const [tlOpen, setTlOpen] = useState<Set<number>>(new Set());
  const [truckEdit, setTruckEdit] = useState<string | null>(null);
  const [valueEdit, setValueEdit] = useState<string | null>(null);
  // Pipeline dropdown selection (filters the stage dropdown); null = track the deal.
  const [pipelineSel, setPipelineSel] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch(dealId ? `/api/crm/deal?id=${dealId}` : `/api/crm/deal?pdId=${pdDealId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(setData)
        .catch((e) => setError(String(e))),
    [dealId, pdDealId]
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
      body: JSON.stringify({ id: data?.deal?.id ?? dealId, ...fields }),
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

  // The confirmation flow lives in whichever pipeline holds "Confirmed (Won)";
  // resolve Deposit/Confirmation-Scheduled within THAT pipeline so the two
  // "Deposit Placed" stages don't get confused.
  const wonStageObj = data.stages.find((s) => /confirmed/i.test(s.name));
  const orderPipeId = wonStageObj?.pipeline_id ?? null;
  const orderStageId = (re: RegExp): string | undefined =>
    (orderPipeId ? data.stages.find((s) => re.test(s.name) && s.pipeline_id === orderPipeId) : undefined)?.id ??
    data.stages.find((s) => re.test(s.name))?.id;

  // Shared pieces the embedded (dialer) layout re-arranges without forking.
  const propertyFields = (
    <>
              <div className="field">
                <label>Pipeline</label>
                <select
                  className="vmsel"
                  style={{ width: "auto" }}
                  value={pipelineSel ?? d.crm_stages?.pipeline_id ?? ""}
                  onChange={(e) => setPipelineSel(e.target.value)}
                  disabled={saving}
                >
                  {data.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Stage</label>
                <select
                  className="vmsel"
                  style={{ width: "auto" }}
                  value={pipelineSel && pipelineSel !== d.crm_stages?.pipeline_id ? "" : d.stage_id ?? ""}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    void update({ stageId: e.target.value });
                    setPipelineSel(null); // re-track the deal after reload
                  }}
                  disabled={saving}
                >
                  <option value="" disabled>Pick a stage…</option>
                  {data.stages
                    .filter((s) => s.pipeline_id === (pipelineSel ?? d.crm_stages?.pipeline_id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label>Owner</label>
                <select
                  className="vmsel"
                  style={{ width: "auto" }}
                  value={d.owner_pipedrive_id ?? ""}
                  onChange={(e) => update({ ownerPipedriveId: e.target.value })}
                  disabled={saving}
                >
                  <option value="" disabled>Owner…</option>
                  <option value="24081760">Parker</option>
                  <option value="24391245">Jackson</option>
                  <option value="24723797">Cainen</option>
                  <option value="23851101">Gabi</option>
                </select>
              </div>
              <div className="field">
                <label>Source</label>
                <select
                  className="vmsel"
                  style={{ width: "auto" }}
                  value={d.source_id ?? ""}
                  onChange={(e) => update({ sourceId: e.target.value || null })}
                  disabled={saving}
                >
                  <option value="">—</option>
                  {data.sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Value ($)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    className="vmsel"
                    style={{ width: 120, fontVariantNumeric: "tabular-nums" }}
                    inputMode="numeric"
                    placeholder="—"
                    value={valueEdit ?? (d.value_cents != null ? String(Math.round(d.value_cents / 100)) : "")}
                    disabled={saving}
                    onChange={(e) => setValueEdit(e.target.value.replace(/[^\d]/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && valueEdit !== null) {
                        void update({ valueDollars: valueEdit === "" ? null : Number(valueEdit) });
                        setValueEdit(null);
                      }
                    }}
                  />
                  {valueEdit !== null && valueEdit !== (d.value_cents != null ? String(Math.round(d.value_cents / 100)) : "") && (
                    <button
                      className="btn primary"
                      style={{ padding: "6px 12px", fontSize: 13 }}
                      disabled={saving}
                      onClick={async () => {
                        await update({ valueDollars: valueEdit === "" ? null : Number(valueEdit) });
                        setValueEdit(null);
                      }}
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>
    </>
  );
  // Truck lives in the contact section (it's about the customer's vehicle).
  // A Save button appears once you start editing (no accidental blur-saves).
  const truckDirty = truckEdit !== null && truckEdit.trim() !== (d.truck_model ?? "");
  const truckFieldEl = (
    <div className="field" style={{ marginTop: 12 }}>
      <label>Truck model</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="vmsel"
          style={{ maxWidth: 220 }}
          placeholder="e.g. Toyota - Tacoma"
          value={truckEdit ?? d.truck_model ?? ""}
          disabled={saving}
          onChange={(e) => setTruckEdit(e.target.value)}
        />
        {truckDirty && (
          <button
            className="btn primary"
            style={{ padding: "6px 12px", fontSize: 13 }}
            disabled={saving}
            onClick={async () => {
              await update({ truckModel: (truckEdit ?? "").trim() || null });
              setTruckEdit(null);
            }}
          >
            Save
          </button>
        )}
      </div>
    </div>
  );

  // Primary interests — toggle chips, saved immediately.
  const dealInterests: string[] = d.interests ?? [];
  const interestsEl = (
    <div className="field" style={{ marginTop: 12 }}>
      <label>Primary interests</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {INTERESTS.map((it) => {
          const on = dealInterests.includes(it);
          return (
            <button
              key={it}
              className={`btn ${on ? "primary" : "ghost"}`}
              style={{ padding: "3px 9px", fontSize: 12 }}
              disabled={saving}
              onClick={() =>
                update({ interests: on ? dealInterests.filter((x) => x !== it) : [...dealInterests, it] })
              }
            >
              {it}
            </button>
          );
        })}
      </div>
    </div>
  );
  const commBarEl = (
    <CommBar
      dealId={d.id}
      pdDealId={d.pipedrive_deal_id ?? null}
      hideCall={embedded}
      contact={contact ? { id: contact.id, name: contact.name, firstName: contact.first_name } : null}
      phone={phones.find((p) => p.primary)?.e164 ?? phones[0]?.e164 ?? phones[0]?.value ?? null}
      allPhones={phones.map((p) => p.e164 ?? p.value).filter(Boolean)}
      email={emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? null}
      onLogged={load}
    />
  );
  const klaviyoEl = emails[0]?.value ? (
    <KlaviyoActivity
      email={emails[0].value}
      contactId={contact?.id ?? null}
      dealId={d.id}
      knownPhones={phones.map((p) => p.e164 ?? p.value)}
      knownTruck={d.truck_model ?? null}
      onSaved={load}
    />
  ) : null;

  return (
    <>
      {!embedded && (
        <>
          <div className="viewsub" style={{ marginBottom: 6 }}>
            <a href="/crm" style={{ color: "var(--text-3)", textDecoration: "none" }}>← All deals</a>
          </div>
          {titleEdit === null ? (
            <h2 className="viewtitle" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {d.title}
              <button
                className="btn ghost"
                style={{ padding: "2px 10px", fontSize: 12, fontWeight: 600 }}
                onClick={() => setTitleEdit(d.title)}
              >
                ✏️ Rename
              </button>
            </h2>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                className="vmsel"
                style={{ fontSize: 20, fontWeight: 700, maxWidth: 520 }}
                value={titleEdit}
                autoFocus
                onChange={(e) => setTitleEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && titleEdit.trim()) {
                    void update({ title: titleEdit.trim() });
                    setTitleEdit(null);
                  }
                  if (e.key === "Escape") setTitleEdit(null);
                }}
              />
              <button
                className="btn primary"
                disabled={saving || !titleEdit.trim() || titleEdit.trim() === d.title}
                onClick={() => {
                  void update({ title: titleEdit.trim() });
                  setTitleEdit(null);
                }}
              >
                Save
              </button>
              <button className="btn ghost" onClick={() => setTitleEdit(null)}>Cancel</button>
            </div>
          )}
          <div className="viewsub">
            {d.crm_stages?.crm_pipelines?.name} ▸ {d.crm_stages?.name ?? "—"} · {d.status}
            {d.value_cents != null && <> · ${Math.round(d.value_cents / 100).toLocaleString()}</>}
          </div>
        </>
      )}
      {warn && <div className="viewsub" style={{ color: "var(--warn)" }}>{warn}</div>}

      {/* Deal properties + outcome — one labeled row above everything. */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", margin: "0 0 18px" }}>
        {!embedded && propertyFields}
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>Outcome</label>
          {(() => {
            const stageName = d.crm_stages?.name ?? "";
            const inDeposit = d.status === "open" && /deposit placed|confirmation scheduled/i.test(stageName);
            const current: "open" | "deposit" | "won" | "lost" =
              d.status === "won" ? "won" : d.status === "lost" ? "lost" : inDeposit ? "deposit" : "open";
            const outcomeBtn = (
              key: "open" | "deposit" | "won" | "lost",
              label: string,
              onClick: () => void,
              title: string
            ) => (
              <button
                className="btn"
                disabled={saving || current === key}
                title={title}
                onClick={onClick}
                style={
                  current === key
                    ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px rgba(217, 91, 49, 0.5)", opacity: 1 }
                    : undefined
                }
              >
                {label}
              </button>
            );
            return (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {outcomeBtn(
                  "open",
                  "🔄 Open",
                  () => {
                    // Back in play — the rep chooses where it lands.
                    setReopenPipe("");
                    setReopenStage("");
                    setModal("reopen");
                  },
                  "Reopen — pick the pipeline & stage it should go back to"
                )}
                {outcomeBtn(
                  "deposit",
                  "💰 Deposit",
                  () => {
                    const depositStage = orderStageId(/deposit placed/i);
                    if (depositStage) void update({ stageId: depositStage, status: "open" });
                    setSchedType("call");
                    setSchedSubject("Confirmation follow-up");
                    setSchedDue("");
                    setDepositFollow(true);
                    setModal("schedule");
                  },
                  "Deposit placed — moves to the Deposit Placed stage and prompts a confirmation follow-up"
                )}
                {outcomeBtn(
                  "won",
                  "✓ Confirmed",
                  () => {
                    const wonStage = orderStageId(/confirmed/i);
                    void update({ status: "won", ...(wonStage ? { stageId: wonStage } : {}) });
                  },
                  "Deal executed — archives as won in Confirmed (Won)"
                )}
                {outcomeBtn(
                  "lost",
                  "✗ Lost",
                  () => {
                    setLostReason("");
                    setModal("lost");
                  },
                  "Requires a loss reason; deal moves to Cainen for re-prospecting"
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {embedded && <div style={{ marginBottom: 18 }}>{commBarEl}</div>}

      <div className="split" style={{ marginTop: 0, ...(embedded ? { gridTemplateColumns: "1fr" } : {}) }}>
        <div>
          {!embedded && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="panel-h">Actions</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn" onClick={() => setModal("note")}>📝 Add note</button>
              <button className="btn" onClick={() => setModal("schedule")}>📅 Schedule activity</button>
              <button className="btn" onClick={() => setModal("sprint")}>
                ⚡ Add to sprint{data.dealSprintIds.length > 0 ? ` (in ${data.dealSprintIds.length})` : ""}
              </button>
            </div>
          </div>
          )}

          {modal === "note" && (
            <ActionModal title="Add note" onClose={() => setModal(null)}>
              <textarea
                className="vmsel"
                rows={4}
                style={{ resize: "vertical" }}
                placeholder="Note… (saves here + Pipedrive)"
                value={note}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  className="btn primary"
                  disabled={!note.trim() || saving}
                  onClick={async () => {
                    await update({ note });
                    setNote("");
                    setModal(null);
                  }}
                >
                  Save note
                </button>
                <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              </div>
            </ActionModal>
          )}

          {modal === "schedule" && (
            <ActionModal
              title={depositFollow ? "💰 Deposit placed — schedule the confirmation follow-up" : "Schedule activity"}
              onClose={() => {
                setDepositFollow(false);
                setModal(null);
              }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                <select className="vmsel" value={schedType} onChange={(e) => setSchedType(e.target.value)}>
                  <option value="call">📞 Call</option>
                  <option value="task">📋 Task</option>
                  <option value="meeting">📅 Meeting</option>
                  <option value="email">✉️ Email</option>
                </select>
                <input
                  className="vmsel"
                  placeholder="What needs to happen?"
                  value={schedSubject}
                  autoFocus
                  onChange={(e) => setSchedSubject(e.target.value)}
                />
                <input
                  type="datetime-local"
                  className="vmsel"
                  value={schedDue}
                  onChange={(e) => setSchedDue(e.target.value)}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!schedSubject.trim() || saving || (depositFollow && !schedDue)}
                    onClick={async () => {
                      const confSched = depositFollow ? orderStageId(/confirmation scheduled/i) : undefined;
                      await update({
                        activity: {
                          type: schedType,
                          subject: schedSubject,
                          dueAt: schedDue ? new Date(schedDue).toISOString() : null,
                        },
                        // Deposit flow: scheduling the confirmation IS the
                        // "Confirmation Scheduled" stage.
                        ...(confSched ? { stageId: confSched } : {}),
                      });
                      setSchedSubject("");
                      setSchedDue("");
                      setDepositFollow(false);
                      setModal(null);
                    }}
                  >
                    Schedule
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setDepositFollow(false);
                      setModal(null);
                    }}
                  >
                    {depositFollow ? "Skip for now" : "Cancel"}
                  </button>
                </div>
              </div>
            </ActionModal>
          )}

          {modal === "log" && (
            <ActionModal title="Log an activity" onClose={() => setModal(null)}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                  Record something that already happened (defaults to now).
                </div>
                <select className="vmsel" value={logType} onChange={(e) => setLogType(e.target.value)}>
                  <option value="call">📞 Call</option>
                  <option value="meeting">📅 Meeting</option>
                  <option value="email">✉️ Email</option>
                  <option value="sms">💬 Text</option>
                  <option value="task">📋 Task</option>
                  <option value="note">📝 Note</option>
                </select>
                <input
                  className="vmsel"
                  placeholder="What happened?"
                  value={logSubject}
                  autoFocus
                  onChange={(e) => setLogSubject(e.target.value)}
                />
                <textarea
                  className="vmsel"
                  rows={3}
                  style={{ resize: "vertical" }}
                  placeholder="Details (optional)"
                  value={logNote}
                  onChange={(e) => setLogNote(e.target.value)}
                />
                <label style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                  When (leave blank for now)
                  <input
                    type="datetime-local"
                    className="vmsel"
                    style={{ marginTop: 4 }}
                    value={logWhen}
                    onChange={(e) => setLogWhen(e.target.value)}
                  />
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!logSubject.trim() || saving}
                    onClick={async () => {
                      await update({
                        logActivity: {
                          type: logType,
                          subject: logSubject.trim(),
                          body: logNote.trim() || undefined,
                          occurredAt: logWhen ? new Date(logWhen).toISOString() : undefined,
                        },
                      });
                      setModal(null);
                    }}
                  >
                    Log it
                  </button>
                  <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                </div>
              </div>
            </ActionModal>
          )}

          {modal === "reopen" && (
            <ActionModal title="Reopen deal" onClose={() => setModal(null)}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                  Choose where this deal goes back into play.
                </div>
                <select className="vmsel" value={reopenPipe} onChange={(e) => { setReopenPipe(e.target.value); setReopenStage(""); }}>
                  <option value="" disabled>Pipeline…</option>
                  {data.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select className="vmsel" value={reopenStage} onChange={(e) => setReopenStage(e.target.value)} disabled={!reopenPipe}>
                  <option value="" disabled>Stage…</option>
                  {data.stages
                    .filter((s) => s.pipeline_id === reopenPipe)
                    .map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                </select>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!reopenStage || saving}
                    onClick={async () => {
                      await update({ status: "open", stageId: reopenStage });
                      setModal(null);
                    }}
                  >
                    Reopen here
                  </button>
                  <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                </div>
              </div>
            </ActionModal>
          )}

          {modal === "lost" && (
            <ActionModal title="Mark lost" onClose={() => setModal(null)}>
              <div style={{ display: "grid", gap: 8 }}>
                <input
                  className="vmsel"
                  placeholder="Loss reason… (e.g. Price, Timing, Went elsewhere)"
                  value={lostReason}
                  autoFocus
                  onChange={(e) => setLostReason(e.target.value)}
                />
                <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                  The deal is unassigned from its owner and moved to Cainen for later re-prospecting.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!lostReason.trim() || saving}
                    onClick={async () => {
                      await update({ status: "lost", lostReason: lostReason.trim(), ownerPipedriveId: 24723797 });
                      setModal(null);
                    }}
                  >
                    Mark lost
                  </button>
                  <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                </div>
              </div>
            </ActionModal>
          )}

          {modal === "sprint" && (
            <ActionModal title="Add to call sprint" onClose={() => setModal(null)}>
              <div style={{ display: "grid", gap: 8 }}>
                <select className="vmsel" value={sprintPick} onChange={(e) => setSprintPick(e.target.value)}>
                  <option value="">Pick a sprint…</option>
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
                      placeholder="Sprint name"
                      value={newSprintName}
                      onChange={(e) => setNewSprintName(e.target.value)}
                    />
                    <select className="vmsel" value={newSprintOwner} onChange={(e) => setNewSprintOwner(e.target.value)}>
                      <option value="">Rep…</option>
                      {data.sprintOwners.map((o) => (
                        <option key={o} value={o}>{o.split("@")[0]}</option>
                      ))}
                    </select>
                  </>
                )}
                {data.dealSprintIds.length > 0 && (
                  <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                    Already in {data.dealSprintIds.length} sprint{data.dealSprintIds.length === 1 ? "" : "s"} — shows in that rep’s dialer.
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={
                      saving ||
                      (sprintPick === "__new" ? !newSprintName.trim() || !newSprintOwner : !sprintPick)
                    }
                    onClick={async () => {
                      await update({
                        sprint:
                          sprintPick === "__new"
                            ? { name: newSprintName, owner: newSprintOwner }
                            : { sprintId: sprintPick },
                      });
                      setSprintPick("");
                      setNewSprintName("");
                      setModal(null);
                    }}
                  >
                    Add to sprint
                  </button>
                  <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                </div>
              </div>
            </ActionModal>
          )}

          {!embedded && commBarEl}

          {(() => {
            const upcoming = data.timeline
              .filter((t) => t.id && t.due && !t.done && t.kind !== "system")
              .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
            if (upcoming.length === 0) return null;
            return (
              <div className="card" style={{ marginBottom: 18 }}>
                <div className="panel-h">Upcoming</div>
                {upcoming.map((t) => {
                  const ea = editAct && editAct.id === t.id ? editAct : null;
                  return ea ? (
                    <div key={t.id} style={{ background: "var(--surface-2)", borderRadius: 10, padding: 10, margin: "6px 0", display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <select
                          className="vmsel"
                          style={{ width: "auto" }}
                          value={ea.type}
                          onChange={(e) => setEditAct((a) => a && { ...a, type: e.target.value })}
                        >
                          <option value="call">📞 Call</option>
                          <option value="task">📋 Task</option>
                          <option value="meeting">📅 Meeting</option>
                          <option value="email">✉️ Email</option>
                        </select>
                        <input
                          className="vmsel"
                          style={{ flex: 1, minWidth: 150 }}
                          value={ea.subject}
                          onChange={(e) => setEditAct((a) => a && { ...a, subject: e.target.value })}
                        />
                        <input
                          type="datetime-local"
                          className="vmsel"
                          style={{ width: "auto" }}
                          value={ea.due}
                          onChange={(e) => setEditAct((a) => a && { ...a, due: e.target.value })}
                        />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn primary"
                          style={{ padding: "6px 14px", fontSize: 13.5 }}
                          disabled={saving || !ea.subject.trim() || !ea.due}
                          onClick={async () => {
                            await update({
                              editActivity: {
                                activityId: ea.id,
                                subject: ea.subject,
                                type: ea.type,
                                dueAt: new Date(ea.due).toISOString(),
                              },
                            });
                            setEditAct(null);
                          }}
                        >
                          Save
                        </button>
                        <button className="btn ghost" style={{ padding: "6px 12px", fontSize: 13.5 }} onClick={() => setEditAct(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="stmt-row" key={t.id} style={{ alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                        <span>{KIND_ICON[t.kind] ?? "•"}</span>
                        <b style={{ fontSize: 14 }}>{t.title}</b>
                        <span style={{ fontSize: 13, color: Date.parse(t.due!) < Date.now() ? "var(--crit)" : "var(--text-3)" }}>
                          {Date.parse(t.due!) < Date.now() ? "overdue · " : "due "}
                          {fmtWhen(t.due)}
                        </span>
                      </div>
                      <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button
                          className="btn ghost"
                          style={{ padding: "4px 10px", fontSize: 13 }}
                          disabled={saving}
                          onClick={() => update({ completeActivityId: t.id })}
                        >
                          ✓ Done
                        </button>
                        <button
                          className="btn ghost"
                          style={{ padding: "4px 9px", fontSize: 13 }}
                          title="Edit"
                          onClick={() => {
                            const d = t.due ? new Date(t.due) : new Date();
                            const pad = (n: number) => String(n).padStart(2, "0");
                            setEditAct({
                              id: t.id!,
                              subject: t.title,
                              type: ["call", "task", "meeting", "email"].includes(t.kind) ? t.kind : "task",
                              due: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
                            });
                          }}
                        >
                          ✏️
                        </button>
                        <button
                          className="btn ghost"
                          style={{
                            padding: "4px 9px",
                            fontSize: 13,
                            ...(confirmDeleteId === t.id ? { background: "var(--crit)", color: "#fff", boxShadow: "none" } : {}),
                          }}
                          disabled={saving}
                          title="Delete"
                          onClick={() => {
                            if (confirmDeleteId === t.id) {
                              setConfirmDeleteId(null);
                              void update({ deleteActivityId: t.id });
                            } else {
                              setConfirmDeleteId(t.id!);
                              setTimeout(() => setConfirmDeleteId((c) => (c === t.id ? null : c)), 3000);
                            }
                          }}
                        >
                          {confirmDeleteId === t.id ? "Sure?" : "🗑"}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <div className="card">
            <div className="panel-h" style={{ display: "flex", alignItems: "center" }}>
              Timeline
              <button
                className="btn ghost"
                style={{ marginLeft: "auto", padding: "3px 11px", fontSize: 12.5 }}
                onClick={() => {
                  setLogType("call");
                  setLogSubject("");
                  setLogNote("");
                  setLogWhen("");
                  setModal("log");
                }}
              >
                ＋ Log activity
              </button>
            </div>
            {data.timeline.length === 0 && (
              <div style={{ color: "var(--text-3)", fontSize: 14 }}>No activity yet.</div>
            )}
            {/* Pending scheduled items live in Upcoming, not the timeline —
                they land here once completed. */}
            {data.timeline.filter((t) => !(t.due && !t.done)).map((t, i) => {
              const isOpen = tlOpen.has(i);
              const long = (t.body?.length ?? 0) > 160;
              return (
                <div
                  className="stmt-row"
                  style={{ alignItems: "flex-start", cursor: t.body ? "pointer" : "default" }}
                  key={i}
                  title={t.body && !isOpen ? "Click to expand" : undefined}
                  onClick={() =>
                    t.body &&
                    setTlOpen((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
                    <span>{KIND_ICON[t.kind] ?? "•"}</span>
                    <div style={{ minWidth: 0 }}>
                      <b style={{ fontSize: 14 }}>{t.title}</b>
                      {t.body && !isOpen && (
                        <div style={{ fontSize: 13.5, color: "var(--text-2)", maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.body}
                          {long ? " …" : ""}
                        </div>
                      )}
                      {t.body && isOpen && (
                        <div style={{ fontSize: 13.5, color: "var(--text-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 4 }}>
                          {t.body}
                        </div>
                      )}
                      {t.actor && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{t.actor}</div>}
                      {isOpen && t.at && (
                        <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3 }}>{new Date(t.at).toLocaleString()}</div>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-3)", flexShrink: 0, marginLeft: 10 }}>
                    {fmtWhen(t.at)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card" style={embedded ? { order: -1 } : undefined}>
          {data.callStats && (
            <>
              <div className="panel-h">Call effort</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                <div className="sstat">
                  <div className="n">{data.callStats.dials}</div>
                  <div className="l">Dials</div>
                </div>
                <div className="sstat">
                  <div className="n">
                    {data.callStats.talkS >= 3600
                      ? `${(data.callStats.talkS / 3600).toFixed(1)}h`
                      : `${Math.round(data.callStats.talkS / 60)}m`}
                  </div>
                  <div className="l">Talk time</div>
                </div>
                <div className="sstat">
                  <div className="n">
                    {data.callStats.dials > 0
                      ? `${Math.round((100 * data.callStats.answered) / data.callStats.dials)}%`
                      : "—"}
                  </div>
                  <div className="l">Answer rate</div>
                </div>
              </div>
            </>
          )}
          {embedded && klaviyoEl}
          {!embedded && (
            <>
          {contact ? (
            <ContactCard contact={contact} phones={phones} emails={emails} truck={<>{truckFieldEl}{interestsEl}</>} onSaved={load} />
          ) : (
            <>
              <div className="panel-h">Contact</div>
              <div style={{ color: "var(--text-3)", fontSize: 14 }}>No linked contact.</div>
            </>
          )}
            </>
          )}
          <div style={embedded ? { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" } : undefined}>
            <div style={embedded ? { flex: 1, minWidth: 170 } : undefined}>
              <div className="panel-h" style={{ marginTop: 16 }}>Record</div>
              <div style={{ fontSize: 13.5, color: "var(--text-3)", lineHeight: 1.8 }}>
                Created {fmtWhen(d.pd_add_time ?? d.created_at)}<br />
                Stage changed {fmtWhen(d.stage_changed_at)}<br />
                Last activity {fmtWhen(d.last_activity_at)}<br />
                Pipedrive #{d.pipedrive_deal_id ?? "—"}
              </div>
            </div>
            {embedded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, minWidth: 210 }}>
                {propertyFields}
                {truckFieldEl}
                {interestsEl}
              </div>
            )}
          </div>
          {!embedded && klaviyoEl}
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
  if (/save.*build|build.*save|3d builder/.test(s)) return "build";
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
  dealId,
  knownPhones,
  knownTruck,
  onSaved,
}: {
  email: string;
  contactId: string | null;
  dealId?: string | null;
  knownPhones: string[];
  knownTruck?: string | null;
  onSaved: () => void;
}) {
  const [events, setEvents] = useState<{ metric: string; at: string; detail: Record<string, unknown> }[] | null>(null);
  const [profilePhones, setProfilePhones] = useState<string[]>([]);
  const [profileTruck, setProfileTruck] = useState<string | null>(null);
  const [addingTruck, setAddingTruck] = useState(false);
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
        setProfileTruck(d.profile?.truckModel ?? null);
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

  // The latest saved build — its link should take zero effort to find.
  const latestBuild = (events ?? []).find((e) => eventKind(e.metric) === "build");
  const buildLink = latestBuild
    ? Object.values(latestBuild.detail ?? {})
        .map((v) => String(v).match(/https?:\/\/[^\s"',]+/)?.[0])
        .find(Boolean) ?? null
    : null;
  const [buildCopied, setBuildCopied] = useState(false);

  return (
    <>
      <div className="panel-h" style={{ marginTop: 16 }}>Marketing signals</div>
      {events === null && !failed && <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>Loading Klaviyo history…</div>}
      {failed && <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>Klaviyo unavailable right now.</div>}
      {events !== null && events.length === 0 && (
        <div style={{ fontSize: 13.5, color: "var(--text-3)" }}>No Klaviyo events for {email}.</div>
      )}
      {dealId && profileTruck && !knownTruck && (
        <div
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
          🛻 Klaviyo has truck model: <b>{profileTruck}</b>
          <button
            className="btn primary"
            style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12.5 }}
            disabled={addingTruck}
            onClick={async () => {
              setAddingTruck(true);
              const r = await fetch("/api/crm/deal", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: dealId, truckModel: profileTruck }),
              }).catch(() => null);
              setAddingTruck(false);
              if (r?.ok) onSaved();
            }}
          >
            {addingTruck ? "…" : "+ Add to deal"}
          </button>
        </div>
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
      {latestBuild && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--accent-soft)",
            border: "1px solid rgba(217, 91, 49, 0.45)",
            borderRadius: 10,
            padding: "9px 12px",
            fontSize: 13.5,
            fontWeight: 700,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          🏗 Latest saved build
          <span style={{ color: "var(--text-3)", fontWeight: 600 }}>{relTime(latestBuild.at)}</span>
          {buildLink ? (
            <button
              className="btn primary"
              style={{ marginLeft: "auto", padding: "4px 14px", fontSize: 12.5 }}
              onClick={() => {
                void navigator.clipboard?.writeText(buildLink).catch(() => {});
                setBuildCopied(true);
                setTimeout(() => setBuildCopied(false), 2000);
              }}
            >
              {buildCopied ? "✓ Link copied" : "📋 Copy build link"}
            </button>
          ) : (
            <span style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: 12, fontWeight: 600 }}>
              no link in event
            </span>
          )}
        </div>
      )}
      {freshBuying && eventKind(freshBuying.metric) !== "build" && (
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
  allPhones = [],
  email,
  onLogged,
  hideCall,
}: {
  dealId: string;
  pdDealId: number | null;
  contact: { id: string; name: string; firstName: string | null } | null;
  phone: string | null;
  allPhones?: string[];
  email: string | null;
  onLogged: () => void;
  hideCall?: boolean;
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
    return () => {
      if (!hideCall) setOutboundHandler(null);
    };
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

  const [showNumPicker, setShowNumPicker] = useState(false);

  const startCall = (target?: string) => {
    const num = target ?? phone;
    if (!num || awaitingDispo) return;
    setShowNumPicker(false);
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
      newOutboundCall(num)
        .then((c) => {
          callRef.current = c;
          setCallState("ringing");
        })
        .catch((e) => setCallState(`error: ${e instanceof Error ? e.message : e}`));
    } else {
      // Call happens in Quo — log the outcome here when it wraps.
      if (method === "web") {
        void navigator.clipboard?.writeText(num).catch(() => {});
        window.open("https://my.quo.com", "quo-web");
      } else if (window.__TAURI__) {
        void window.__TAURI__.core.invoke("open_tel", { url: `tel:${num}` }).catch(() => {});
      } else {
        window.location.href = `tel:${num}`;
      }
      setAwaitingDispo(true);
    }
  };

  /** Multiple numbers → let the rep pick which to try. */
  const onCallClick = () => {
    if (allPhones.length > 1) setShowNumPicker(true);
    else startCall();
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
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${hideCall ? 3 : 4}, 1fr)`, gap: 10 }}>
        {!hideCall && (callState === null ? (
          <button className="btn" style={btnStyle} disabled={!phone || awaitingDispo} title={allPhones.length > 1 ? "Pick which number to try" : phone ?? "No phone on contact"} onClick={onCallClick}>
            📞 Call{allPhones.length > 1 ? ` (${allPhones.length})` : ""}
          </button>
        ) : callState.startsWith("error") ? (
          <button className="btn" style={{ ...btnStyle, color: "var(--crit)" }} onClick={() => setCallState(null)} title={callState}>
            📞 Failed — retry
          </button>
        ) : (
          <button className="btn" style={{ ...btnStyle, background: "var(--crit)", color: "#fff" }} onClick={endCall}>
            ⏹ {callState === "active" ? "On call" : "Ringing…"}
          </button>
        ))}
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

      {showNumPicker && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-2)", marginBottom: 8 }}>Which number?</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {allPhones.map((n) => (
              <button key={n} className="btn" style={{ fontVariantNumeric: "tabular-nums" }} onClick={() => startCall(n)}>
                📞 {n}{n === phone ? " · primary" : ""}
              </button>
            ))}
            <button className="btn ghost" onClick={() => setShowNumPicker(false)}>Cancel</button>
          </div>
        </div>
      )}

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

/** Centered popup for deal actions (note / schedule / sprint). */
function ActionModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center" }}
      onClick={onClose}
    >
      <div className="card" style={{ width: 460, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div className="panel-h" style={{ marginBottom: 0 }}>{title}</div>
          <button className="btn ghost" style={{ marginLeft: "auto", padding: "2px 10px", fontSize: 13 }} onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Editable contact card (name / phones / emails, click-to-call) ──────────

interface CardPhone { value: string; e164?: string; primary?: boolean }
interface CardEmail { value: string; primary?: boolean }

function ContactCard({
  contact,
  phones,
  emails,
  truck,
  onSaved,
}: {
  contact: { id: string; name: string; first_name?: string | null; last_name?: string | null; org_name?: string | null };
  phones: CardPhone[];
  emails: CardEmail[];
  truck: React.ReactNode;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [callHint, setCallHint] = useState(false);

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true);
    const r = await fetch("/api/crm/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: contact.id, ...payload }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) onSaved();
    return Boolean(r?.ok);
  };

  const startEdit = () => {
    // Prefer stored first/last; else split the display name.
    const parts = (contact.name ?? "").trim().split(/\s+/);
    setFirst(contact.first_name ?? parts[0] ?? "");
    setLast(contact.last_name ?? parts.slice(1).join(" ") ?? "");
    setEditing(true);
  };

  const callNumber = (num: string) => {
    const method = localStorage.getItem("dialMethod") ?? "desktop";
    if (method === "web") {
      void navigator.clipboard?.writeText(num).catch(() => {});
      window.open("https://my.quo.com", "quo-web");
      setCallHint(true);
      setTimeout(() => setCallHint(false), 6000);
    } else if (typeof window !== "undefined" && window.__TAURI__) {
      void window.__TAURI__.core.invoke("open_tel", { url: `tel:${num}` }).catch(() => {});
    } else {
      window.location.href = `tel:${num}`;
    }
  };

  const phoneKey = (p: CardPhone) => p.e164 ?? p.value;

  return (
    <>
      <div className="panel-h" style={{ display: "flex", alignItems: "center" }}>
        Contact
        <button
          className="btn ghost"
          style={{ marginLeft: "auto", padding: "2px 10px", fontSize: 12 }}
          onClick={() => (editing ? setEditing(false) : startEdit())}
        >
          {editing ? "Done" : "✏️ Edit"}
        </button>
      </div>

      {editing ? (
        <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="vmsel" placeholder="First" value={first} onChange={(e) => setFirst(e.target.value)} />
            <input className="vmsel" placeholder="Last" value={last} onChange={(e) => setLast(e.target.value)} />
            <button
              className="btn primary"
              style={{ padding: "6px 12px", fontSize: 13 }}
              disabled={busy || !(first.trim() || last.trim())}
              onClick={() => post({ op: "rename", firstName: first, lastName: last })}
            >
              Save
            </button>
          </div>

          {phones.map((p) => (
            <EditableValue
              key={phoneKey(p)}
              icon="📞"
              value={p.e164 ?? p.value}
              primary={!!p.primary}
              busy={busy}
              onPrimary={() => post({ op: "set_primary_phone", value: phoneKey(p) })}
              onSave={(v) => post({ op: "edit_phone", value: phoneKey(p), newValue: v })}
              onRemove={() => post({ op: "remove_phone", value: phoneKey(p) })}
            />
          ))}
          {emails.map((e) => (
            <EditableValue
              key={e.value}
              icon="✉️"
              value={e.value}
              primary={!!e.primary}
              busy={busy}
              onPrimary={() => post({ op: "set_primary_email", value: e.value })}
              onSave={(v) => post({ op: "edit_email", value: e.value, newValue: v })}
              onRemove={() => post({ op: "remove_email", value: e.value })}
            />
          ))}
          <AddContactDetail contactId={contact.id} onSaved={onSaved} />
          {truck}
        </div>
      ) : (
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
                    title="Call"
                    onClick={(e) => {
                      if (localStorage.getItem("dialMethod") === "web" || (typeof window !== "undefined" && window.__TAURI__)) {
                        e.preventDefault();
                        callNumber(num);
                      }
                    }}
                  >
                    {num}
                  </a>
                  {p.primary && <span style={{ fontSize: 11, color: "var(--text-3)" }}> · primary</span>}
                </div>
              );
            })}
            {callHint && <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>📋 Number copied — paste into the Quo web dialer (⌘V)</div>}
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
                {e.primary && <span style={{ fontSize: 11, color: "var(--text-3)" }}> · primary</span>}
              </div>
            ))}
            {phones.length === 0 && emails.length === 0 && (
              <div style={{ color: "var(--text-3)", fontSize: 14 }}>No contact details.</div>
            )}
          </div>
          {truck}
        </>
      )}
    </>
  );
}

/** One editable phone/email row: edit value, ⭐ set primary, 🗑 remove. */
function EditableValue({
  icon,
  value,
  primary,
  busy,
  onPrimary,
  onSave,
  onRemove,
}: {
  icon: string;
  value: string;
  primary: boolean;
  busy: boolean;
  onPrimary: () => void;
  onSave: (v: string) => void;
  onRemove: () => void;
}) {
  const [v, setV] = useState(value);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <input className="vmsel" style={{ flex: 1 }} value={v} onChange={(e) => setV(e.target.value)} />
      <button
        className="btn ghost"
        style={{ padding: "4px 9px", fontSize: 12, color: primary ? "var(--accent)" : undefined }}
        title={primary ? "Primary" : "Make primary"}
        disabled={busy || primary}
        onClick={onPrimary}
      >
        {primary ? "★" : "☆"}
      </button>
      {v.trim() !== value && (
        <button className="btn primary" style={{ padding: "4px 10px", fontSize: 12 }} disabled={busy} onClick={() => onSave(v.trim())}>
          Save
        </button>
      )}
      <button className="btn ghost" style={{ padding: "4px 9px", fontSize: 12 }} title="Remove" disabled={busy} onClick={onRemove}>
        🗑
      </button>
    </div>
  );
}
