"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { newOutboundCall, setOutboundHandler } from "./phoneClient";
import { INTERESTS } from "./interests";
import { combineDue } from "@/lib/allday";
import { fillPlaceholders } from "@/lib/placeholders";
import { linkifyPlain, linkifyHtml, htmlToPlain, isHtml } from "@/lib/richtext";
import { openChat } from "./chatDockStore";
import RichTextEditor, { isEmptyHtml } from "./RichTextEditor";
import MentionInput from "./MentionInput";
import { useRoster, ownerName } from "./useRoster";
import { ScriptsCard } from "./ScriptsCard";
import { CallReviewInline } from "./CallReviewCard";
import { CloseLikelihood } from "./CloseLikelihood";

interface DealData {
  deal: any;
  timeline: { id?: string; kind: string; at: string | null; title: string; body: string | null; media?: string[] | null; audio?: string | null; actor: string | null; done: boolean; due: string | null; callId?: string | null; reviewable?: boolean; reviewed?: boolean; emailDirection?: string | null; track?: { opens: number; clicks: number; lastOpenAt: string | null } | null }[];
  callStats: { dials: number; answered: number; talkS: number; inbound: number } | null;
  adInfo?: { source: string | null; campaign: string | null; channel: string | null; leadCostCents: number | null } | null;
  adJourney?: {
    interactions: {
      at: string | null; source: string; channel: string | null; campaign: string | null; adId: string | null; origin: string; costCents: number | null;
      campaignId?: string | null; adsetId?: string | null; medium?: string | null; content?: string | null; clickIds?: string[];
      surveyAnswer?: string | null; viaSurvey?: boolean; pricedBy?: string | null;
    }[];
    totalCostCents: number;
    priced: number;
    unpriced: number;
  } | null;
  aiProfile?: {
    attributes: Record<string, { value: string; confidence: number; evidence?: string[] }>;
    archetypes: { key: string; name: string; pct: number; confidence?: number; evidence?: string[] }[];
    tags?: string[];
    summary: string | null;
    next_action: {
      action?: string;
      rationale?: string;
      questions_to_ask?: string[];
      data_sufficiency?: { band: string; coverage_note?: string; known_gaps?: { attribute: string; why?: string }[] };
    } | null;
    overall_confidence: number | null;
    status: string;
    runs: number;
    last_run_at: string | null;
  } | null;
  aiProfileStale?: boolean;
  sources: { id: string; name: string }[];
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string; pipeline_id: string; crm_pipelines: { name: string } | null }[];
  sprints: { id: string; name: string; owner: string }[];
  dealSprintIds: string[];
  sprintOwners: string[];
}

export type AiProfile = NonNullable<DealData["aiProfile"]>;

// Deal meta the dialer renders in its own chrome (pipeline/stage/source above
// the lead card, value in the card, Record in the right rail).
export interface DialerDeal {
  value_cents: number | null;
  pipeline_id: string | null;
  stage_id: string | null;
  source_id: string | null;
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string; pipeline_id: string }[];
  sources: { id: string; name: string }[];
  record: { created: string | null; stageChanged: string | null; lastActivity: string | null; pdId: number | null };
  saving: boolean;
  update: (fields: Record<string, unknown>) => Promise<void>;
}

const KIND_ICON: Record<string, string> = {
  call: "📞", sms: "💬", email: "✉️", task: "📋", note: "📝", meeting: "📅", system: "⚙️",
};

// Shared by the CommBar's post-call flow AND the Log-activity modal — same
// dispositions, same follow-up subjects, same quick-date math as the dialer.
const DISPOSITIONS: [string, string][] = [
  ["connected", "✅ Connected"],
  ["vm_dropped", "🎙 VM left"],
  ["bad_number", "🚫 Bad number"],
  ["callback", "📅 Callback set"],
  ["confirmation", "📋 Confirmation call"],
  ["no_answer", "📵 No answer"],
];
const FOLLOW_UP_SUBJECT: Record<string, string> = {
  connected: "Continue conversation",
  vm_dropped: "Follow up — voicemail left",
  no_answer: "Follow up — no answer",
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

// ── Prefetch cache ─────────────────────────────────────────────────────────
// Lets the dialer warm the NEXT lead's deal (and its AI profile) during the
// post-call review pause, so advancing paints instantly instead of showing a
// loading spinner + a 10s "Analyzing…" profile build.
const dealCache = new Map<string, { at: number; data: DealData }>();
const DEAL_CACHE_TTL = 90_000;
const dealUrl = (dealId?: string, pdDealId?: number | null) =>
  dealId ? `/api/crm/deal?id=${dealId}` : `/api/crm/deal?pdId=${pdDealId}`;
function getCachedDeal(dealId?: string, pdDealId?: number | null): DealData | null {
  const hit = dealCache.get(dealUrl(dealId, pdDealId));
  return hit && Date.now() - hit.at < DEAL_CACHE_TTL ? hit.data : null;
}

/**
 * Warm a deal for a snappy open: fetch it into the cache and — mirroring the
 * deal page's silent auto-build — build the AI profile if the server says it's
 * due, then re-cache so the profile is present on open. Cheap + idempotent:
 * skips if a fresh copy is already cached; the profile POST no-ops server-side
 * when nothing changed.
 */
export async function prefetchDeal(opts: { dealId?: string; pdDealId?: number | null }): Promise<void> {
  const url = dealUrl(opts.dealId, opts.pdDealId);
  if (getCachedDeal(opts.dealId, opts.pdDealId)) return; // already warm
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const data: DealData = await r.json();
    dealCache.set(url, { at: Date.now(), data });
    if (data?.aiProfileStale && data?.deal?.id) {
      const pr = await fetch("/api/ai/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: data.deal.id, manual: false }),
      }).catch(() => null);
      const pd = pr?.ok ? await pr.json().catch(() => null) : null;
      if (pd?.ran) {
        const r2 = await fetch(url).catch(() => null);
        if (r2?.ok) dealCache.set(url, { at: Date.now(), data: await r2.json() });
      }
    }
  } catch {}
}

export function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function DealDetailView({
  dealId,
  pdDealId,
  embedded,
  onProfile,
  onDeal,
}: {
  dealId?: string;
  pdDealId?: number;
  embedded?: boolean;
  // Embedded (dialer) mode surfaces the AI profile up so the dialer can render
  // the summary + confidence/archetypes in its own chrome.
  onProfile?: (p: { profile: AiProfile | null; stale: boolean; building: boolean }) => void;
  // …and the deal meta (value, pipeline/stage/source, record + update fn).
  onDeal?: (d: DialerDeal | null) => void;
}) {
  const router = useRouter();
  // Seed from the prefetch cache (warmed during the dialer's review step) so an
  // advanced-to deal paints instantly; load() still revalidates in background.
  const [data, setData] = useState<DealData | null>(() => getCachedDeal(dealId, pdDealId));
  const [error, setError] = useState<string | null>(null);
  const roster = useRoster();
  const [note, setNote] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  // Reply-to-inbound-email prompt: set by the ↩ Reply button on an inbound
  // email row; the CommBar opens its email composer threaded to it.
  const [emailReply, setEmailReply] = useState<{ activityId: string; subject: string } | null>(null);

  // Editing an existing timeline note (✏️ on an expanded note row).
  const [noteEdit, setNoteEdit] = useState<{ id: string; title: string; body: string } | null>(null);
  const [noteDelArmed, setNoteDelArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const [schedType, setSchedType] = useState("call");
  const [schedSubject, setSchedSubject] = useState("");
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState(""); // blank = all-day (no 5pm default)
  const [sprintPick, setSprintPick] = useState("");
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [newSprintName, setNewSprintName] = useState("");
  const [newSprintOwner, setNewSprintOwner] = useState("");
  // Upcoming-activity inline editor
  const [editAct, setEditAct] = useState<{ id: string; subject: string; type: string; due: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | "note" | "schedule" | "sprint" | "lost" | "reopen" | "log" | "snooze">(null);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [logType, setLogType] = useState("call");
  const [logSubject, setLogSubject] = useState("");
  const [logNote, setLogNote] = useState("");
  const [logWhen, setLogWhen] = useState("");
  // Call logs run through the disposition flow (same as the dialer).
  const [logDispo, setLogDispo] = useState<string | null>(null);
  const [logNoAnswer, setLogNoAnswer] = useState<string | null>(null);
  const [logNextDays, setLogNextDays] = useState<number | "custom" | null>(null);
  const [logNextCustom, setLogNextCustom] = useState("");
  const [logNextType, setLogNextType] = useState("call");
  const [logBusy, setLogBusy] = useState(false);
  const [depositFollow, setDepositFollow] = useState(false); // schedule modal opened by the Deposit flow
  const [lostReason, setLostReason] = useState("");
  const [lostCat, setLostCat] = useState<string | null>(null);
  const [competitorName, setCompetitorName] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [reopenPipe, setReopenPipe] = useState("");
  const [reopenStage, setReopenStage] = useState("");
  const [tlOpen, setTlOpen] = useState<Set<number>>(new Set());
  const [truckEdit, setTruckEdit] = useState<string | null>(null);
  const [valueEdit, setValueEdit] = useState<string | null>(null);
  // Pipeline dropdown selection (filters the stage dropdown); null = track the deal.
  const [pipelineSel, setPipelineSel] = useState<string | null>(null);

  const load = useCallback(
    (retried = false): Promise<void> =>
      fetch(dealUrl(dealId, pdDealId))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: DealData) => {
          setData(d);
          dealCache.set(dealUrl(dealId, pdDealId), { at: Date.now(), data: d });
        })
        .catch((e) => {
          // Transient 401s happen when two windows race the same session's
          // token refresh (aux windows share cookies) — one retry heals it.
          if (!retried && String(e).includes("401")) {
            return new Promise<void>((res) => setTimeout(res, 1500)).then(() => load(true));
          }
          setError(String(e));
        }),
    [dealId, pdDealId]
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Keep the timeline live — inbound texts/calls land via webhook, so a
  // gentle refresh surfaces replies without a manual reload. Skips hidden tabs.
  useEffect(() => {
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 30_000);
    return () => clearInterval(iv);
  }, [load]);

  // Embedded mode: the dialer renders the profile's summary + confidence itself,
  // so the DealProfileSection isn't mounted here — own its silent auto-build and
  // surface the profile up via onProfile.
  const [aiBuilding, setAiBuilding] = useState(false);
  const autoAiTried = useRef(false);
  useEffect(() => {
    if (!embedded || !data?.aiProfileStale || autoAiTried.current) return;
    autoAiTried.current = true;
    const id = data.deal?.id;
    if (!id) return;
    setAiBuilding(true);
    fetch("/api/ai/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId: id, manual: false }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.ran) return load();
      })
      .catch(() => {})
      .finally(() => setAiBuilding(false));
  }, [embedded, data?.aiProfileStale, data?.deal?.id, load]);
  // New lead → allow the auto-build to run once for it.
  useEffect(() => {
    autoAiTried.current = false;
  }, [dealId, pdDealId]);
  useEffect(() => {
    if (embedded) onProfile?.({ profile: data?.aiProfile ?? null, stale: !!data?.aiProfileStale, building: aiBuilding });
  }, [embedded, data, aiBuilding, onProfile]);

  const update = useCallback(
    async (fields: Record<string, unknown>) => {
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
    },
    [data?.deal?.id, dealId, load]
  );

  // Surface deal meta to the dialer (renders pipeline/stage/source/value/record
  // in its own chrome). Only the fields the dialer needs, plus the update fn.
  useEffect(() => {
    if (!embedded) return;
    const d = data?.deal;
    if (!d) {
      onDeal?.(null);
      return;
    }
    onDeal?.({
      value_cents: d.value_cents ?? null,
      pipeline_id: d.crm_stages?.pipeline_id ?? null,
      stage_id: d.stage_id ?? null,
      source_id: d.source_id ?? null,
      pipelines: data.pipelines,
      stages: data.stages,
      sources: data.sources,
      record: {
        created: d.pd_add_time ?? d.created_at ?? null,
        stageChanged: d.stage_changed_at ?? null,
        lastActivity: d.last_activity_at ?? null,
        pdId: d.pipedrive_deal_id ?? null,
      },
      saving,
      update,
    });
  }, [embedded, data, saving, update, onDeal]);

  if (error) return <div className="viewsub">Couldn’t load deal: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const d = data.deal;
  const contact = d.crm_contacts;
  const phones = (contact?.phones ?? []) as { value: string; e164?: string; primary?: boolean; bad?: boolean }[];
  // Numbers struck bad (bad_number disposition) are never the call default.
  const goodPhones = phones.filter((p) => !p.bad);
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
                  onChange={(e) => update({ ownerPipedriveId: e.target.value ? Number(e.target.value) : null })}
                  disabled={saving}
                >
                  <option value="">Unassigned (pool)</option>
                  {d.owner_pipedrive_id != null &&
                    !roster.active.some((o) => String(o.id) === String(d.owner_pipedrive_id)) && (
                      <option value={d.owner_pipedrive_id}>{ownerName(roster, d.owner_pipedrive_id)} (inactive)</option>
                    )}
                  {roster.active.map((o) => (
                    <option key={o.id} value={String(o.id)}>{o.name}</option>
                  ))}
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
              {data.adInfo && (data.adInfo.source || data.adInfo.channel) && (
                <div className="field">
                  <label>Ad</label>
                  <div style={{ fontSize: 13.5, paddingTop: 7, whiteSpace: "nowrap" }} title="From Triple Whale pixel / first-party capture">
                    <span style={{ color: "var(--accent)", fontWeight: 650 }}>{data.adInfo.source ?? data.adInfo.channel}</span>
                    {data.adInfo.campaign && <span style={{ color: "var(--text-3)" }}> · {String(data.adInfo.campaign).slice(0, 16)}</span>}
                    {data.adInfo.leadCostCents != null && (
                      <span style={{ color: "var(--text-2)" }}> · ~${Math.round(data.adInfo.leadCostCents / 100)}/lead</span>
                    )}
                  </div>
                </div>
              )}
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
  // Embedded (dialer) keeps only the read-only Ad attribution here; pipeline/
  // stage/source/value/owner move into the dialer chrome.
  const adFieldEl =
    data.adInfo && (data.adInfo.source || data.adInfo.channel) ? (
      <div className="field">
        <label>Ad</label>
        <div style={{ fontSize: 13.5, paddingTop: 7, whiteSpace: "nowrap" }} title="From Triple Whale pixel / first-party capture">
          <span style={{ color: "var(--accent)", fontWeight: 650 }}>{data.adInfo.source ?? data.adInfo.channel}</span>
          {data.adInfo.campaign && <span style={{ color: "var(--text-3)" }}> · {String(data.adInfo.campaign).slice(0, 16)}</span>}
          {data.adInfo.leadCostCents != null && (
            <span style={{ color: "var(--text-2)" }}> · ~${Math.round(data.adInfo.leadCostCents / 100)}/lead</span>
          )}
        </div>
      </div>
    ) : null;
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
      contact={contact ? { id: contact.id, name: contact.name, firstName: contact.first_name, lastName: contact.last_name } : null}
      dealTitle={d.title}
      truck={d.truck_model ?? null}
      phone={goodPhones.find((p) => p.primary)?.e164 ?? goodPhones[0]?.e164 ?? goodPhones[0]?.value ?? null}
      allPhones={goodPhones.map((p) => p.e164 ?? p.value).filter(Boolean)}
      email={emails.find((e) => e.primary)?.value ?? emails[0]?.value ?? null}
      onLogged={load}
      replyPrompt={emailReply}
      onReplyConsumed={() => setEmailReply(null)}
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
      compact={embedded}
    />
  ) : null;
  const adJourneyEl = data.adJourney ? <AdJourneySection journey={data.adJourney} /> : null;
  const profileEl = (
    <>
      {d.status === "open" && <CloseLikelihood dealId={d.id} />}
      <DealProfileSection profile={data.aiProfile ?? null} stale={!!data.aiProfileStale} dealId={d.id} onRefreshed={load} />
    </>
  );
  const scriptsEl = (
    <ScriptsCard
      dealId={d.id}
      phone={goodPhones.find((p) => p.primary)?.e164 ?? goodPhones[0]?.e164 ?? goodPhones[0]?.value ?? null}
      contactName={contact?.name ?? null}
      hasEmail={!!(emails.find((e) => e.primary)?.value ?? emails[0]?.value)}
      defaultOpen={embedded}
    />
  );

  return (
    <>
      {!embedded && (
        <>
          <div className="viewsub" style={{ marginBottom: 6 }}>
            {/* Return to whichever list you came from (CRM or a Sprint list),
                restored to where you left it; fall back to the CRM list. */}
            <span
              onClick={() => (typeof window !== "undefined" && window.history.length > 1 ? router.back() : router.push("/crm"))}
              style={{ color: "var(--text-3)", textDecoration: "none", cursor: "pointer" }}
            >
              ← Back
            </span>
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
                    // Atomic: the deposit is only recorded WHEN the
                    // confirmation follow-up is scheduled (required).
                    setSchedType("call");
                    setSchedSubject("Confirmation follow-up");
                    setSchedDate("");
                    setSchedTime("");
                    setDepositFollow(true);
                    setModal("schedule");
                  },
                  "Deposit placed — requires scheduling the confirmation follow-up"
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
                  "Pick a loss category — DNC & duplicate close immediately; no-interest / no-contact / not-qualified unassign back to the pool"
                )}
                <button
                  className="btn ghost"
                  style={{ fontSize: 12.5 }}
                  onClick={() => setMergeOpen(true)}
                  title="Merge a duplicate deal into this one"
                >
                  ⧉ Merge
                </button>
              </div>
            );
          })()}
        </div>
      </div>

      {mergeOpen && (
        <MergeDealModal
          survivorId={d.id}
          survivorTitle={d.title}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            setMergeOpen(false);
            load();
          }}
        />
      )}

      {embedded && <div style={{ marginBottom: 18 }}>{commBarEl}{scriptsEl}</div>}

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
              <button
                className="btn"
                style={(d as any).sprint_snooze_until && (d as any).sprint_snooze_until >= new Date().toISOString().slice(0, 10) ? { color: "var(--warn)" } : undefined}
                title="Keep this deal off the daily sprint call lists until a date"
                onClick={() => {
                  const cur = (d as any).sprint_snooze_until as string | null;
                  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
                  setSnoozeDate(cur && cur >= new Date().toISOString().slice(0, 10) ? cur : week);
                  setModal("snooze");
                }}
              >
                😴 {(d as any).sprint_snooze_until && (d as any).sprint_snooze_until >= new Date().toISOString().slice(0, 10)
                  ? `Snoozed → ${(d as any).sprint_snooze_until.slice(5).replace("-", "/")}`
                  : "Snooze lists"}
              </button>
            </div>
          </div>
          )}

          {modal === "snooze" && (
            <ActionModal title="Snooze from call lists" onClose={() => setModal(null)}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontSize: 13, color: "var(--text-3)" }}>
                  This deal won't appear on any sprint list until the date below. It stays visible everywhere else.
                </div>
                <input type="date" className="vmsel" value={snoozeDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setSnoozeDate(e.target.value)} />
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[[7, "1 week"], [14, "2 weeks"], [30, "1 month"], [90, "3 months"]].map(([days, label]) => (
                    <button key={String(label)} className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setSnoozeDate(new Date(Date.now() + Number(days) * 86_400_000).toISOString().slice(0, 10))}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!snoozeDate || saving}
                    onClick={async () => {
                      await update({ sprintSnoozeUntil: snoozeDate });
                      setModal(null);
                    }}
                  >
                    Snooze
                  </button>
                  {(d as any).sprint_snooze_until && (
                    <button className="btn ghost" disabled={saving} onClick={async () => { await update({ sprintSnoozeUntil: null }); setModal(null); }}>
                      Clear snooze
                    </button>
                  )}
                  <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => setModal(null)}>Cancel</button>
                </div>
              </div>
            </ActionModal>
          )}

          {modal === "note" && (
            <ActionModal title="Add note" onClose={() => setModal(null)}>
              <input
                className="vmsel"
                placeholder="Title (optional)"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <MentionInput
                rows={4}
                placeholder="Note… (@name to tag a teammate)"
                value={note}
                autoFocus
                onChange={setNote}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  className="btn primary"
                  disabled={!note.trim() || saving}
                  onClick={async () => {
                    await update({ note, noteTitle });
                    setNote("");
                    setNoteTitle("");
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
              title={depositFollow ? "💰 Deposit — confirmation follow-up required" : "Schedule activity"}
              onClose={() => {
                setDepositFollow(false);
                setModal(null);
              }}
            >
              {depositFollow && (
                <p style={{ fontSize: 13, color: "var(--text-3)", margin: "0 0 8px" }}>
                  The deposit is recorded when you schedule the confirmation — closing this cancels the deposit action.
                </p>
              )}
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
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="date" className="vmsel" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} style={{ flex: 1 }} />
                  <input type="time" className="vmsel" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} style={{ width: 120 }} title="Leave blank for all-day" />
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: -2 }}>Leave the time blank for an all-day activity.</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!schedSubject.trim() || saving || (depositFollow && !schedDate)}
                    onClick={async () => {
                      const confSched = depositFollow
                        ? orderStageId(/confirmation scheduled/i) ?? orderStageId(/deposit placed/i)
                        : undefined;
                      await update({
                        activity: {
                          type: schedType,
                          subject: schedSubject,
                          dueAt: combineDue(schedDate, schedTime),
                        },
                        // Deposit flow: the deposit + its confirmation follow-up
                        // land together — stage moves only now.
                        ...(confSched ? { stageId: confSched, status: "open" } : {}),
                      });
                      setSchedSubject("");
                      setSchedDate("");
                      setSchedTime("");
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
                    {depositFollow ? "Cancel deposit" : "Cancel"}
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

                {logType === "call" ? (
                  <>
                    {/* Same dispositions as the dialer — the log runs through the
                        disposition flow (call stats, bad-number strike, pool claim). */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {DISPOSITIONS.map(([k, label]) => (
                        <button
                          key={k}
                          className={`btn ${logDispo === k ? "primary" : "ghost"}`}
                          style={{ padding: "5px 10px", fontSize: 13 }}
                          onClick={() => { setLogDispo(k); if (k !== "no_answer") setLogNoAnswer(null); }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {logDispo === "no_answer" && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>Why?</span>
                        <button className={`btn ${logNoAnswer === "ignored" ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setLogNoAnswer((r) => (r === "ignored" ? null : "ignored"))}>
                          🙈 Ignored
                        </button>
                        <button className={`btn ${logNoAnswer === "vm_unavailable" ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setLogNoAnswer((r) => (r === "vm_unavailable" ? null : "vm_unavailable"))}>
                          📪 VM full / not set
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <input
                    className="vmsel"
                    placeholder="What happened?"
                    value={logSubject}
                    autoFocus
                    onChange={(e) => setLogSubject(e.target.value)}
                  />
                )}

                <MentionInput rows={3} placeholder="Details… (@name to tag a teammate, optional)" value={logNote} onChange={setLogNote} />

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

                {/* Next step — same quick scheduling the dialer offers post-dispo. */}
                <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>Next step:</span>
                    <select className="vmsel" style={{ width: "auto", padding: "5px 8px", fontSize: 13 }} value={logNextType} onChange={(e) => setLogNextType(e.target.value)}>
                      <option value="call">📞 Call</option>
                      <option value="sms">💬 Text</option>
                      <option value="email">✉️ Email</option>
                      <option value="task">📋 Task</option>
                      <option value="meeting">📅 Meeting</option>
                    </select>
                    {[[1, "Tomorrow"], [3, "3 days"], [7, "1 week"]].map(([days, label]) => (
                      <button
                        key={String(label)}
                        className={`btn ${logNextDays === days ? "primary" : "ghost"}`}
                        style={{ padding: "4px 10px", fontSize: 12.5 }}
                        onClick={() => setLogNextDays((v) => (v === days ? null : (days as number)))}
                      >
                        {label}
                      </button>
                    ))}
                    <button className={`btn ${logNextDays === "custom" ? "primary" : "ghost"}`} style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => setLogNextDays((v) => (v === "custom" ? null : "custom"))}>
                      Custom
                    </button>
                    {logNextDays === "custom" && (
                      <input type="date" className="vmsel" style={{ width: "auto", fontSize: 12.5, padding: "4px 8px" }} value={logNextCustom} onChange={(e) => setLogNextCustom(e.target.value)} />
                    )}
                    {logNextDays === null && <span style={{ fontSize: 12, color: "var(--text-3)" }}>(none)</span>}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={logBusy || saving || (logType === "call" ? !logDispo : !logSubject.trim())}
                    onClick={async () => {
                      setLogBusy(true);
                      try {
                        const whenIso = logWhen ? new Date(logWhen).toISOString() : new Date().toISOString();
                        const dueAt =
                          logNextDays === "custom"
                            ? (logNextCustom ? new Date(`${logNextCustom}T09:00:00`).toISOString() : null)
                            : logNextDays != null
                              ? followUpAt(logNextDays)
                              : null;
                        const reasonLabel = logDispo === "no_answer" && logNoAnswer ? (logNoAnswer === "ignored" ? "ignored" : "VM full / not set") : null;
                        const logPhone = goodPhones.find((p) => p.primary)?.e164 ?? goodPhones[0]?.e164 ?? goodPhones[0]?.value ?? null;

                        if (logType === "call" && logDispo && logPhone) {
                          // Full disposition flow — identical to a dialer call:
                          // call_events row (stats), bad-number strike, PD sync,
                          // reprospect claim, note w/ mentions, next-step.
                          const followSubject = reasonLabel ? `Follow up — no answer (${reasonLabel})` : FOLLOW_UP_SUBJECT[logDispo] ?? "Follow up";
                          const noteText = reasonLabel ? `No answer — ${reasonLabel}${logNote.trim() ? " · " + logNote.trim() : ""}` : logNote.trim() || null;
                          const r = await fetch("/api/dialer/disposition", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              phone: logPhone,
                              disposition: logDispo,
                              dialStartedAt: whenIso,
                              final: true,
                              dealId: d.pipedrive_deal_id ?? undefined,
                              crmDealId: d.id,
                              note: noteText,
                              next: dueAt ? { type: logNextType, subject: followSubject, dueAt } : undefined,
                            }),
                          });
                          if (!r.ok) throw new Error(`HTTP ${r.status}`);
                          await load();
                        } else {
                          // Non-call types (or no phone): plain timeline log +
                          // optional scheduled next step.
                          const subject = logType === "call" && logDispo
                            ? DISPOSITIONS.find(([k]) => k === logDispo)?.[1] ?? "Call"
                            : logSubject.trim();
                          await update({
                            logActivity: { type: logType, subject, body: logNote.trim() || undefined, occurredAt: whenIso },
                          });
                          if (dueAt) {
                            await update({ activity: { type: logNextType, subject: `Follow up — ${subject}`, dueAt } });
                          }
                        }
                        setModal(null);
                        setLogDispo(null);
                        setLogNoAnswer(null);
                        setLogNextDays(null);
                        setLogNextCustom("");
                        setLogNote("");
                        setLogSubject("");
                      } catch {
                        setWarn("Log failed — try again");
                      } finally {
                        setLogBusy(false);
                      }
                    }}
                  >
                    {logBusy ? "Logging…" : "Log it"}
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
            <ActionModal title="Close out deal" onClose={() => { setModal(null); setLostCat(null); setLostReason(""); setCompetitorName(""); }}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {([
                    ["dnc", "🚫 DNC", "Customer asked us not to contact them — marked lost, contact excluded from all lists & engines"],
                    ["no_interest", "😐 No interest", "Stays open — released to the reprospecting pool, unassigned"],
                    ["no_contact", "📵 No contact made", "Stays open — released to the reprospecting pool, unassigned"],
                    ["competitor", "🏁 Competitor purchase", "Marked lost — competitor name required"],
                    ["not_qualified", "⛔ Not qualified", "Stays open — released to the reprospecting pool, unassigned"],
                    ["duplicate", "🔗 Duplicate deal", "Marked lost (tip: ⧉ Merge preserves the timeline instead)"],
                  ] as [string, string, string][]).map(([key, label, desc]) => (
                    <button
                      key={key}
                      className="btn ghost"
                      title={desc}
                      style={{
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        border: lostCat === key ? "1px solid var(--accent)" : "1px solid var(--border-soft)",
                        background: lostCat === key ? "var(--accent-soft)" : undefined,
                      }}
                      onClick={() => setLostCat(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {lostCat && (
                  <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
                    {lostCat === "dnc" && "Deal is marked lost and the contact is flagged Do-Not-Contact — excluded from sprint lists, dialer queues, and intake engines permanently."}
                    {["no_interest", "no_contact", "not_qualified"].includes(lostCat) && "The deal STAYS OPEN: it's unassigned and returns to the reprospecting pool, where sprint lists resurface it by marketing signal."}
                    {lostCat === "competitor" && "Deal is marked lost with the competitor recorded."}
                    {lostCat === "duplicate" && "Deal is marked lost as a duplicate. If the other deal is the keeper, ⧉ Merge moves this timeline onto it instead."}
                  </div>
                )}

                {lostCat === "competitor" && (
                  <input
                    className="vmsel"
                    placeholder="Competitor name (required)"
                    value={competitorName}
                    autoFocus
                    onChange={(e) => setCompetitorName(e.target.value)}
                  />
                )}
                {lostCat && (
                  <input
                    className="vmsel"
                    placeholder="Optional detail…"
                    value={lostReason}
                    onChange={(e) => setLostReason(e.target.value)}
                  />
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn primary"
                    disabled={!lostCat || saving || (lostCat === "competitor" && !competitorName.trim())}
                    onClick={async () => {
                      await update({
                        lostCategory: {
                          key: lostCat,
                          ...(lostCat === "competitor" ? { competitor: competitorName.trim() } : {}),
                          ...(lostReason.trim() ? { detail: lostReason.trim() } : {}),
                        },
                      });
                      setModal(null);
                      setLostCat(null);
                      setLostReason("");
                      setCompetitorName("");
                    }}
                  >
                    {lostCat && ["no_interest", "no_contact", "not_qualified"].includes(lostCat) ? "Release to pool" : "Mark lost"}
                  </button>
                  <button className="btn ghost" onClick={() => { setModal(null); setLostCat(null); setLostReason(""); setCompetitorName(""); }}>Cancel</button>
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
                  setLogDispo(null);
                  setLogNoAnswer(null);
                  setLogNextDays(null);
                  setLogNextCustom("");
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
                          {/* Linkify: URLs (e.g. saved-build links) become click-to-copy — the
                              FULL stored URL, no error-prone manual selection. */}
                          <Linkify text={t.body} />
                        </div>
                      )}
                      {t.kind === "email" && t.track && (t.track.opens > 0 || t.track.clicks > 0) && (
                        <div style={{ fontSize: 12, color: "var(--ok, #3aa76d)", marginTop: 2 }}>
                          👁 Opened ×{t.track.opens}
                          {t.track.clicks > 0 && <> · 🔗 {t.track.clicks} click{t.track.clicks === 1 ? "" : "s"}</>}
                          {t.track.lastOpenAt && (
                            <span style={{ color: "var(--text-3)" }}> · last {new Date(t.track.lastOpenAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                          )}
                        </div>
                      )}
                      {t.kind === "email" && t.emailDirection === "inbound" && t.id && (
                        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 6 }}>
                          <button
                            className="btn ghost"
                            style={{ padding: "2px 10px", fontSize: 12 }}
                            onClick={() => {
                              const base = t.title.replace(/ · \(contact\)$/, "").replace(/^📥\s*/, "").trim();
                              setEmailReply({
                                activityId: String(t.id),
                                subject: /^re:/i.test(base) ? base : `Re: ${base}`,
                              });
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                          >
                            ↩ Reply
                          </button>
                        </div>
                      )}
                      {isOpen && t.kind === "note" && t.id && !String(t.id).startsWith("sms-") && (
                        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 6 }}>
                          <button
                            className="btn ghost"
                            style={{ padding: "2px 10px", fontSize: 12 }}
                            onClick={() => {
                              const title = t.title.replace(/ · \(contact\)$/, "").replace(/^📝\s*/, "").trim();
                              setNoteDelArmed(false);
                              setNoteEdit({ id: String(t.id), title: /^note$/i.test(title) ? "" : title, body: t.body ?? "" });
                            }}
                          >
                            ✏️ Edit note
                          </button>
                        </div>
                      )}
                      {isOpen && t.audio && (
                        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 6 }}>
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                          <audio controls preload="none" src={t.audio} style={{ width: "100%", maxWidth: 340, height: 36 }} />
                        </div>
                      )}
                      {isOpen && t.reviewable && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <CallReviewInline dealId={data.deal.id} activityId={t.callId ? null : String(t.id ?? "") || null} callId={t.callId ?? null} reviewed={!!t.reviewed} />
                        </div>
                      )}
                      {isOpen && (t.media ?? []).length > 0 && (
                        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                          {t.media!.map((u, mi) => (
                            <a key={mi} href={u} target="_blank" rel="noreferrer">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={u} alt="attachment" loading="lazy" style={{ maxWidth: 180, maxHeight: 180, borderRadius: 8, border: "1px solid var(--border-soft)", display: "block" }} />
                            </a>
                          ))}
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

        {noteEdit && (
          <ActionModal title="Edit note" onClose={() => setNoteEdit(null)}>
            <input
              className="vmsel"
              placeholder="Title (optional)"
              value={noteEdit.title}
              onChange={(e) => setNoteEdit((n) => (n ? { ...n, title: e.target.value } : n))}
              style={{ marginBottom: 8 }}
            />
            <MentionInput
              rows={6}
              value={noteEdit.body}
              autoFocus
              onChange={(v) => setNoteEdit((n) => (n ? { ...n, body: v } : n))}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
              <button
                className="btn primary"
                disabled={!noteEdit.body.trim() || saving}
                onClick={async () => {
                  await update({
                    editActivity: {
                      activityId: noteEdit.id,
                      subject: noteEdit.title.trim() ? `📝 ${noteEdit.title.trim()}` : "📝 Note",
                      body: noteEdit.body,
                    },
                  });
                  setNoteEdit(null);
                }}
              >
                Save
              </button>
              <button className="btn ghost" onClick={() => setNoteEdit(null)}>Cancel</button>
              {/* Two-click delete — window.confirm is a no-op in the companion. */}
              <button
                className="btn ghost"
                style={{ marginLeft: "auto", color: "var(--crit)" }}
                disabled={saving}
                onClick={async () => {
                  if (!noteDelArmed) {
                    setNoteDelArmed(true);
                    return;
                  }
                  await update({ deleteActivityId: noteEdit.id });
                  setNoteEdit(null);
                }}
              >
                {noteDelArmed ? "🗑 Really delete?" : "🗑 Delete"}
              </button>
            </div>
          </ActionModal>
        )}

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
          {/* Dialer: the suggested next action sits right under Call effort;
              summary + confidence/archetypes render in the dialer chrome. */}
          {embedded && <NextActionCard profile={data.aiProfile ?? null} building={aiBuilding} />}
          {embedded && klaviyoEl}
          {embedded && adJourneyEl}
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
          {/* Record + editable pipeline/stage/source/value move into the dialer
              chrome in embedded mode (surfaced via onDeal); keep Ad + truck +
              interests here for context. */}
          {!embedded && (
            <>
              <div className="panel-h" style={{ marginTop: 16 }}>Record</div>
              <div style={{ fontSize: 13.5, color: "var(--text-3)", lineHeight: 1.8 }}>
                Created {fmtWhen(d.pd_add_time ?? d.created_at)}<br />
                Stage changed {fmtWhen(d.stage_changed_at)}<br />
                Last activity {fmtWhen(d.last_activity_at)}<br />
                Deal #{d.pipedrive_deal_id ?? "—"}
              </div>
            </>
          )}
          {embedded && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
              {adFieldEl}
              {truckFieldEl}
              {interestsEl}
            </div>
          )}
          {!embedded && klaviyoEl}
          {!embedded && adJourneyEl}
          {!embedded && profileEl}
          {!embedded && scriptsEl}
        </div>
      </div>
    </>
  );
}

// ── Ad interactions (below marketing signals) ──────────────────────────────
// Every recorded ad touch for this person — TW pixel journey clicks across
// all their orders + first-party captured touches — each paid click priced
// at the channel's real CPC, summed into an actual acquisition cost.

const CHANNEL_BADGE: Record<string, string> = {
  google: "#4a94ec", facebook: "#7b6be0", chatgpt: "#4cc44c", microsoft: "#3aa0a0",
  tiktok: "#d95b7a", pinterest: "#c0392b", snapchat: "#d9c53a", reddit: "#e8623a",
  linkedin: "#3a7ac0", twitter: "#5aa0d0",
};

export const BAND_COLOR: Record<string, string> = { Thin: "var(--crit)", Developing: "var(--warn)", Solid: "var(--accent)", Rich: "var(--good)" };
export const humanize = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

interface MergeCandidate {
  id: string;
  title: string;
  status: string;
  valueCents: number | null;
  pipeline: string | null;
  stage: string | null;
  contactName: string | null;
  hasPd: boolean;
}

/** Merge a duplicate deal INTO this one (this deal survives). */
function MergeDealModal({
  survivorId,
  survivorTitle,
  onClose,
  onMerged,
}: {
  survivorId: string;
  survivorTitle: string;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [cands, setCands] = useState<MergeCandidate[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<MergeCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const search = useCallback(
    (term: string) => {
      const qs = new URLSearchParams({ dealId: survivorId });
      if (term.trim()) qs.set("q", term.trim());
      fetch(`/api/crm/deal/duplicates?${qs}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setCands(d.candidates ?? []))
        .catch(() => {});
    },
    [survivorId]
  );
  useEffect(() => search(""), [search]);

  const doMerge = async () => {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/crm/deal/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dupId: pick.id, survivorId }),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      setErr("Merge failed");
      return;
    }
    onMerged();
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: "92%", maxHeight: "82vh", overflowY: "auto" }}>
        <b style={{ fontSize: 16 }}>⧉ Merge a duplicate into this deal</b>
        <div className="viewsub" style={{ marginTop: 2 }}>
          Keeping <strong>{survivorTitle}</strong>. The deal you pick will be closed and its activities moved here.
        </div>

        <input
          className="vmsel"
          style={{ margin: "12px 0 8px" }}
          placeholder="Same-contact deals shown; type to search all titles…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            search(e.target.value);
          }}
        />

        <div style={{ display: "grid", gap: 6 }}>
          {cands.length === 0 && <div style={{ fontSize: 13, color: "var(--text-3)" }}>No candidates. Try searching a title.</div>}
          {cands.map((c) => (
            <label
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                border: `1px solid ${pick?.id === c.id ? "var(--accent)" : "var(--border-soft)"}`,
                background: pick?.id === c.id ? "var(--accent-2-soft)" : "transparent",
              }}
            >
              <input type="radio" name="dup" checked={pick?.id === c.id} onChange={() => setPick(c)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                  {c.status !== "open" ? `${c.status} · ` : ""}{c.pipeline ? `${c.pipeline} / ${c.stage}` : "—"}
                  {c.valueCents != null ? ` · $${Math.round(c.valueCents / 100).toLocaleString()}` : ""}
                  {!c.hasPd ? " · native" : ""}
                </div>
              </div>
            </label>
          ))}
        </div>

        {err && <div style={{ color: "var(--crit)", fontSize: 13, marginTop: 8 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
          <button className="btn primary" disabled={!pick || busy} onClick={doMerge}>
            {busy ? "Merging…" : pick ? `Merge "${pick.title.slice(0, 24)}" in` : "Pick a duplicate"}
          </button>
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Can&apos;t be undone.</span>
          <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Dialer-only: the suggested next action, shown right under Call effort.
 * Collapsed shows the action line; expanding reveals the questions to ask and
 * the data-sufficiency / gaps note.
 */
function NextActionCard({ profile, building }: { profile: AiProfile | null; building: boolean }) {
  const na = profile?.next_action;
  const ds = na?.data_sufficiency;

  if (!na?.action) {
    return (
      <div style={{ marginBottom: 14, fontSize: 12.5, color: "var(--text-3)" }}>
        {building ? (
          <span>
            <span className="ai-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", display: "inline-block", marginRight: 6 }} />
            Building AI next action…
          </span>
        ) : (
          "🧠 No AI next action yet."
        )}
      </div>
    );
  }

  const hasQuestions = (na.questions_to_ask ?? []).length > 0;
  return (
    <div style={{ background: "var(--surface-2, rgba(127,127,127,0.06))", borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        🧠 Suggested next action
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 4 }}>{na.action}</div>
      {hasQuestions && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>
            Ask on the next touch
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-2)" }}>
            {na.questions_to_ask!.map((q, i) => (
              <li key={i} style={{ marginBottom: 2 }}>&ldquo;{q}&rdquo;</li>
            ))}
          </ul>
        </div>
      )}
      {ds && (
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>
          {ds.coverage_note}
          {(ds.known_gaps ?? []).length > 0 && <span> · Missing: {ds.known_gaps!.map((g) => humanize(g.attribute)).join(", ")}</span>}
        </div>
      )}
    </div>
  );
}

function DealProfileSection({
  profile,
  stale,
  dealId,
  onRefreshed,
}: {
  profile: NonNullable<DealData["aiProfile"]> | null;
  stale: boolean;
  dealId: string;
  onRefreshed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const autoTried = useRef(false);

  const build = useCallback(
    async (opts: { manual?: boolean; silent?: boolean }) => {
      setBusy(true); // always show a loading state — even the silent auto-build
      setErr(null);
      const r = await fetch("/api/ai/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId, manual: opts.manual === true }),
      }).catch(() => null);
      setBusy(false);
      if (!r?.ok) {
        if (!opts.silent) setErr("Build failed");
        return;
      }
      const d = await r.json();
      if (!opts.silent && !d.ran && d.reason) setErr(d.reason);
      if (d.ran) onRefreshed();
    },
    [dealId, onRefreshed]
  );

  // Rep correction: pin an item as wrong — display drops it immediately and
  // the profiler never re-asserts it.
  const correct = useCallback(
    async (op: string, key: string) => {
      await fetch("/api/ai/profile-correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId, op, key }),
      }).catch(() => {});
      onRefreshed();
    },
    [dealId, onRefreshed]
  );

  // Free-text feedback — becomes verified fact + immediate re-extraction.
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const sendNote = async () => {
    if (!noteText.trim() || noteBusy) return;
    setNoteBusy(true);
    await fetch("/api/ai/profile-correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId, op: "note", key: noteText.trim() }),
    }).catch(() => {});
    setNoteBusy(false);
    setNoteText("");
    setNoteOpen(false);
    onRefreshed();
  };

  const xBtn = (title: string, fn: () => void) => (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        fn();
      }}
      style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 11, padding: "0 2px", lineHeight: 1 }}
    >
      ✕
    </button>
  );

  // Auto-build on open when the engine says it's due (enabled + eligible +
  // new activity). Runs once per mount; the server no-ops if nothing's due.
  useEffect(() => {
    if (stale && !autoTried.current) {
      autoTried.current = true;
      void build({ silent: true });
    }
  }, [stale, build]);

  const ds = profile?.next_action?.data_sufficiency;
  const conf = profile?.overall_confidence;

  return (
    <div style={{ marginTop: 18 }}>
      <div className="panel-h" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        🧠 AI Buyer Profile
        {ds?.band && (
          <span className="chip stage" style={{ background: BAND_COLOR[ds.band] ?? "var(--text-3)", color: "#fff", borderColor: "transparent" }}>
            {ds.band}
          </span>
        )}
        {conf != null && <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{Math.round(conf * 100)}% confidence</span>}
        <button className="btn ghost" style={{ marginLeft: "auto", padding: "2px 10px", fontSize: 12 }} disabled={busy} onClick={() => build({ manual: true })}>
          {busy ? "Thinking…" : profile ? "↻ Refresh" : "Build profile"}
        </button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: "var(--crit)", marginBottom: 6 }}>{err}</div>}

      {busy && !profile && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-2)", padding: "6px 0" }}>
          <span className="ai-pulse" style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
          Analyzing transcripts, ads &amp; signals… <span style={{ color: "var(--text-3)" }}>(~10s)</span>
        </div>
      )}

      {!profile && !busy && (
        <div style={{ fontSize: 13, color: "var(--text-3)" }}>
          No profile yet. Build one from this deal&apos;s transcripts, ad journey, and signals.
        </div>
      )}
      {busy && profile && (
        <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>
          <span className="ai-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", display: "inline-block", marginRight: 6 }} />
          Refreshing with the latest signals…
        </div>
      )}

      {profile && (
        <div style={{ display: "grid", gap: 12 }}>
          {/* Archetype fit bars */}
          <div>
            {(profile.archetypes ?? []).slice(0, 4).map((a) => (
              <div key={a.key} style={{ marginBottom: 6 }} title={(a.evidence ?? []).join(" · ")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12.5, marginBottom: 2 }}>
                  <span style={{ fontWeight: 600 }}>
                    {a.name} {xBtn("Not a fit — the AI won't use this archetype again", () => void correct("archetype_wrong", a.key))}
                  </span>
                  <span style={{ color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{Math.round(a.pct)}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--border-soft)", overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(a.pct, 100)}%`, height: "100%", background: "var(--accent)", borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>

          {profile.summary && <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-1)" }}>{profile.summary}</div>}

          {/* Specific tags (surfing, dogs, boat…) */}
          {(profile.tags ?? []).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {profile.tags!.map((t) => (
                <span key={t} className="chip stage" style={{ background: "var(--accent-2-soft)", color: "var(--text-1)", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 3 }}>
                  #{t} {xBtn("Wrong — never re-add this tag", () => void correct("tag_remove", t))}
                </span>
              ))}
            </div>
          )}

          {/* Key attributes */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(profile.attributes ?? {})
              .filter(([, v]) => v?.value && !/^unknown/i.test(String(v.value)))
              .slice(0, 16)
              .map(([k, v]) => (
                <span
                  key={k}
                  title={`${(v.confidence ?? 0) * 100 | 0}% confident${(v.evidence ?? []).length ? " · " + (v.evidence ?? []).join(" · ") : ""}`}
                  className="chip stage"
                  style={{ opacity: 0.5 + Math.min(v.confidence ?? 0.5, 1) * 0.5, display: "inline-flex", alignItems: "center", gap: 3 }}
                >
                  {humanize(k)}: <strong style={{ marginLeft: 3 }}>{v.value}</strong>
                  {xBtn("Wrong — the AI won't assert this attribute again", () => void correct("attribute_clear", k))}
                </span>
              ))}
          </div>

          {/* Next action */}
          {profile.next_action?.action && (
            <div style={{ background: "var(--surface-2, rgba(127,127,127,0.06))", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                Suggested next action
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: (profile.next_action.questions_to_ask ?? []).length ? 8 : 0 }}>
                {profile.next_action.action}
              </div>
              {(profile.next_action.questions_to_ask ?? []).length > 0 && (
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-3)", marginBottom: 3 }}>Ask on the next touch:</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-2)" }}>
                    {profile.next_action.questions_to_ask!.map((q, i) => (
                      <li key={i} style={{ marginBottom: 2 }}>&ldquo;{q}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Data-sufficiency / gaps */}
          {ds && (
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>
              {ds.coverage_note}
              {(ds.known_gaps ?? []).length > 0 && (
                <span> · Missing: {ds.known_gaps!.map((g) => humanize(g.attribute)).join(", ")}</span>
              )}
            </div>
          )}

          {/* Free-text feedback → pinned fact + immediate re-read */}
          <div>
            {!noteOpen ? (
              <button className="btn ghost" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setNoteOpen(true)}>
                ✎ Tell the AI something it got wrong
              </button>
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="vmsel"
                  style={{ flex: 1, fontSize: 12.5 }}
                  placeholder={`e.g. "not a hunter — that was his brother" or "budget is ~$15k"`}
                  value={noteText}
                  autoFocus
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void sendNote()}
                />
                <button className="btn primary" style={{ padding: "5px 12px", fontSize: 12.5 }} disabled={!noteText.trim() || noteBusy} onClick={() => void sendNote()}>
                  {noteBusy ? "Re-reading…" : "Teach"}
                </button>
                <button className="btn ghost" style={{ padding: "5px 9px", fontSize: 12.5 }} onClick={() => { setNoteOpen(false); setNoteText(""); }}>✕</button>
              </div>
            )}
          </div>

          {profile.last_run_at && (
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              Updated {fmtWhen(profile.last_run_at)} · run #{profile.runs} · {profile.last_run_at ? "" : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AdJourneySection({ journey }: { journey: NonNullable<DealData["adJourney"]> }) {
  const [open, setOpen] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const shown = open ? journey.interactions : journey.interactions.slice(0, 6);

  const ORIGIN_LABEL: Record<string, string> = {
    tw: "Triple Whale order attribution (pixel journey tied to their purchase)",
    site: "First-party site visit (our attr.js beacon saw this click land)",
    survey: "Post-purchase survey — the customer's own answer to “how did you hear about us?”",
  };

  const Detail = ({ label, value }: { label: string; value: string }) => (
    <div style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
      <span style={{ color: "var(--text-3)", minWidth: 88, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--text-2)", wordBreak: "break-word" }}>{value}</span>
    </div>
  );

  return (
    <>
      <div className="panel-h" style={{ marginTop: 16 }}>
        Ad interactions
        <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text-2)", marginLeft: 8 }}>
          ~${Math.round(journey.totalCostCents / 100).toLocaleString()} ad cost
          <span style={{ color: "var(--text-3)" }}>
            {" "}· {journey.priced} priced click{journey.priced === 1 ? "" : "s"}
            {journey.unpriced > 0 ? ` · ${journey.unpriced} unpriced` : ""}
          </span>
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {shown.map((i, idx) => {
          const color = i.channel ? CHANNEL_BADGE[i.channel] ?? "var(--accent)" : "var(--text-3)";
          const isOpen = openIdx === idx;
          return (
            <div key={idx}>
              <div
                style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, padding: "3px 2px", cursor: "pointer", borderRadius: 6, background: isOpen ? "var(--surface-2)" : undefined }}
                title={isOpen ? undefined : "Click for details"}
                onClick={() => setOpenIdx(isOpen ? null : idx)}
              >
                <span style={{ color: "var(--text-3)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", minWidth: 92 }}>
                  {i.at
                    ? new Date(i.at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "2-digit" })
                    : "—"}
                </span>
                <span style={{ color, fontWeight: i.channel ? 650 : 500, whiteSpace: "nowrap" }}>
                  {i.origin === "survey" ? "📋 " : ""}{i.source}
                </span>
                {i.origin === "survey" && i.surveyAnswer && (
                  <span style={{ color: "var(--text-2)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }} title={i.surveyAnswer}>
                    “{i.surveyAnswer}”
                  </span>
                )}
                {i.campaign && (
                  <span style={{ color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }} title={i.campaign}>
                    {i.campaign}
                  </span>
                )}
                {i.viaSurvey && <span style={{ fontSize: 11, color: "var(--text-3)" }}>(via survey)</span>}
                {i.origin === "site" && <span style={{ fontSize: 11, color: "var(--text-3)" }}>(site)</span>}
                <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: i.costCents != null ? "var(--text-1)" : "var(--text-3)", whiteSpace: "nowrap" }}>
                  {i.costCents != null ? `$${(i.costCents / 100).toFixed(2)}` : i.channel ? "?" : ""}
                </span>
              </div>

              {isOpen && (
                <div style={{ margin: "2px 0 6px 100px", padding: "8px 12px", background: "var(--surface-2)", borderRadius: 8, display: "grid", gap: 4 }}>
                  {i.at && (
                    <Detail label="When" value={new Date(i.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) + " PT"} />
                  )}
                  <Detail label="Recorded by" value={ORIGIN_LABEL[i.origin] ?? i.origin} />
                  {i.surveyAnswer && <Detail label="They said" value={`“${i.surveyAnswer}”`} />}
                  {i.viaSurvey && <Detail label="Note" value="Platform credited from the customer's survey answer, not a tracked click." />}
                  {i.channel && <Detail label="Channel" value={i.channel} />}
                  {i.campaign && <Detail label="Campaign" value={i.campaign + (i.campaignId && i.campaignId !== i.campaign ? ` (id ${i.campaignId})` : "")} />}
                  {!i.campaign && i.campaignId && <Detail label="Campaign id" value={i.campaignId} />}
                  {i.adId && <Detail label="Ad id" value={i.adId} />}
                  {i.adsetId && <Detail label="Ad set" value={i.adsetId} />}
                  {i.medium && <Detail label="Medium" value={i.medium} />}
                  {i.content && <Detail label="Content" value={i.content} />}
                  {i.clickIds?.length ? <Detail label="Click ids" value={i.clickIds.join(", ")} /> : null}
                  <Detail
                    label="Est. cost"
                    value={
                      i.costCents != null
                        ? `$${(i.costCents / 100).toFixed(2)} — ${i.pricedBy === "campaign" ? "this campaign's average CPC" : "channel-average CPC"}`
                        : i.channel
                          ? "unknown — paid channel but no click-cost data"
                          : "free (organic / survey / direct)"
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
        {journey.interactions.length > 6 && (
          <button className="btn ghost" style={{ alignSelf: "flex-start", padding: "3px 10px", fontSize: 12.5 }} onClick={() => setOpen(!open)}>
            {open ? "Show less" : `Show all ${journey.interactions.length}`}
          </button>
        )}
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
// Clipboard with WKWebView fallback — navigator.clipboard can be missing or
// silently rejected in the companion's webview; execCommand still works there.
function copyText(s: string) {
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {}
  };
  try {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(s).catch(fallback);
    else fallback();
  } catch {
    fallback();
  }
}

function Linkify({ text }: { text: string }) {
  // Don't break URLs on commas/apostrophes — saved-build links carry long
  // comma-separated accessory lists; a comma-split copy is a dead link. Only
  // trailing sentence punctuation is trimmed off the match.
  const parts = String(text).split(/(https?:\/\/[^\s<>"]+)/g);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  return (
    <>
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return <span key={i}>{p}</span>;
        const url = p.replace(/[.,;:!?)\]'"]+$/, "");
        const tail = p.slice(url.length);
        return (
          <span key={i}>
            <a
              href={url}
              style={{ color: "var(--accent-2)", wordBreak: "break-all", cursor: "copy" }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                copyText(url);
                setCopiedIdx(i);
                setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 2000);
              }}
              title="Click to copy the link"
            >
              {url}
            </a>
            {tail}
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
        );
      })}
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
  compact,
}: {
  email: string;
  contactId: string | null;
  dealId?: string | null;
  knownPhones: string[];
  knownTruck?: string | null;
  onSaved: () => void;
  compact?: boolean;
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

  const collapsedLimit = compact ? 3 : 15;
  const shown = events ? (showAll ? events : events.slice(0, collapsedLimit)) : [];
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
          {events && events.length > collapsedLimit && (
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center", padding: "6px 0", fontSize: 13 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "▴ Show fewer" : `▾ Show all ${events.length} events`}
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
  asset_ids?: string[];
}
interface Asset {
  id: string;
  kind: "url" | "media";
  name: string;
  url: string;
}

type CommChannel = "sms" | "whatsapp" | "email" | "note";

function CommBar({
  dealId,
  pdDealId,
  contact,
  dealTitle,
  truck,
  phone,
  allPhones = [],
  email,
  onLogged,
  hideCall,
  replyPrompt,
  onReplyConsumed,
}: {
  dealId: string;
  pdDealId: number | null;
  contact: { id: string; name: string; firstName: string | null; lastName?: string | null } | null;
  dealTitle?: string | null;
  truck?: string | null;
  phone: string | null;
  allPhones?: string[];
  email: string | null;
  onLogged: () => void;
  hideCall?: boolean;
  replyPrompt?: { activityId: string; subject: string } | null;
  onReplyConsumed?: () => void;
}) {
  const [channel, setChannel] = useState<CommChannel | null>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [attachIds, setAttachIds] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [sending, setSending] = useState(false);
  const [replyToActivityId, setReplyToActivityId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [waProfileId, setWaProfileId] = useState<string | null | "missing">(null);
  // Browser-mode call state (Telnyx singleton)
  const [callState, setCallState] = useState<string | null>(null);
  const callRef = useRef<any>(null);

  // Reply button on an inbound email row → open the email composer threaded
  // to that message.
  useEffect(() => {
    if (!replyPrompt) return;
    setChannel("email");
    setSubject(replyPrompt.subject);
    setReplyToActivityId(replyPrompt.activityId);
    onReplyConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyPrompt]);

  // ── Disposition flow — same shape as the dialer's ──
  const dialStartedAtRef = useRef<string | null>(null);
  const [awaitingDispo, setAwaitingDispo] = useState(false);
  const [pendingDispo, setPendingDispo] = useState<string | null>(null);
  const [dispoNote, setDispoNote] = useState("");
  const [nextType, setNextType] = useState("call");
  const [customDue, setCustomDue] = useState("");
  const [showCustomDue, setShowCustomDue] = useState(false);

  // DISPOSITIONS / FOLLOW_UP_SUBJECT / followUpAt hoisted to module scope —
  // shared with the Log-activity modal.

  useEffect(() => {
    fetch("/api/crm/comm-library")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setMacros(d.myMacros ?? []); // the rep's own toggled/edited macros
        setAssets(d.assets ?? []);
      })
      .catch(() => {});
    return () => {
      if (!hideCall) setOutboundHandler(null);
    };
  }, []);

  // "Use in email composer" from Scripts & drafts: open the email channel
  // pre-filled (markdown links upconvert in the rich editor).
  useEffect(() => {
    const onCompose = (e: Event) => {
      const d = (e as CustomEvent).detail as { dealId?: string; channel?: string; subject?: string; body?: string };
      if (d?.dealId !== dealId || d.channel !== "email") return;
      setErr(null);
      setChannel("email");
      setSubject(d.subject ?? "");
      setBody(d.body ?? "");
    };
    window.addEventListener("lpo:compose", onCompose);
    return () => window.removeEventListener("lpo:compose", onCompose);
  }, [dealId]);

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
    fillPlaceholders(text, {
      firstName: contact?.firstName,
      lastName: contact?.lastName,
      name: contact?.name,
      dealTitle,
      truck,
    });

  const applyMacro = (id: string) => {
    const m = macros.find((x) => x.id === id);
    if (!m) return;
    // Pull in the macro's pre-assigned assets: URLs as links in the body,
    // media into the attachment tray. The rep can still add/remove their own.
    const linked = (m.asset_ids ?? []).map((aid) => assets.find((a) => a.id === aid)).filter(Boolean) as Asset[];
    const urlAssets = linked.filter((a) => a.kind === "url");
    if (channel === "email") {
      // Email body is HTML — upconvert plain macros, append links as anchors.
      let html = isHtml(m.body) ? renderTemplate(m.body) : linkifyHtml(renderTemplate(m.body));
      for (const a of urlAssets) html += `<br><a href="${a.url}">${a.name}</a>`;
      setBody(html);
    } else {
      let text = isHtml(m.body) ? htmlToPlain(renderTemplate(m.body)) : renderTemplate(m.body);
      for (const a of urlAssets) text += `\n[${a.name}](${a.url})`;
      setBody(text);
    }
    if (m.subject && channel === "email") setSubject(renderTemplate(m.subject));
    const media = linked.filter((a) => a.kind === "media");
    if (media.length && channel === "email") setAttachIds((prev) => [...new Set([...prev, ...media.map((a) => a.id)])]);
  };

  const appendAsset = (id: string) => {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    // URL assets insert as a labeled link: recipients see the name, click →
    // the URL. Email gets a real anchor; SMS/WA flatten to "name: url".
    if (channel === "email") {
      const token = a.kind === "url" ? `<a href="${a.url}">${a.name}</a>` : `<a href="${a.url}">${a.url}</a>`;
      setBody((b) => (b ? `${b}&nbsp;${token}` : token));
    } else {
      const token = a.kind === "url" ? `[${a.name}](${a.url})` : a.url;
      setBody((b) => (b ? `${b.trimEnd()} ${token}` : token));
    }
  };

  /** Toggle composers; an email-HTML draft flattens when a plain channel opens. */
  const switchChannel = (c: CommChannel) => {
    setErr(null);
    if (c !== "email" && channel !== c && body && isHtml(body)) setBody(htmlToPlain(body));
    setChannel((prev) => (prev === c ? null : c));
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

  // Call popup extras: talk timer + mute toggle.
  const [callSec, setCallSec] = useState(0);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (callState !== "active") {
      setCallSec(0);
      setMuted(false);
      return;
    }
    const iv = setInterval(() => setCallSec((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [callState]);
  const toggleMute = () => {
    try {
      if (muted) callRef.current?.unmuteAudio();
      else callRef.current?.muteAudio();
      setMuted(!muted);
    } catch {}
  };
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

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
    // Email body is editor HTML — "empty" means no visible content, not "".
    if (channel === "email" ? isEmptyHtml(text) : !text) return;
    if (sending) return;
    setSending(true);
    setErr(null);
    try {
      let r: Response | null = null;
      // Plain-text channels can't render hyperlinks — flatten [label](url) to
      // "label: url". Email sends HTML; the server builds the plain alternative.
      const plain = linkifyPlain(text);
      if (channel === "sms") {
        r = await fetch("/api/texts/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phone, body: plain, crmDealId: dealId, contactId: contact?.id }),
        });
      } else if (channel === "whatsapp") {
        if (!waProfileId || waProfileId === "missing") throw new Error("No Klaviyo profile for this contact");
        r = await fetch("/api/crm/whatsapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: waProfileId, message: plain, dealId, contactId: contact?.id }),
        });
      } else if (channel === "email") {
        if (!subject.trim()) throw new Error("Subject required");
        r = await fetch("/api/gmail/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: email, subject: subject.trim(), body: text, dealId, contactId: contact?.id, attachmentAssetIds: attachIds, replyToActivityId: replyToActivityId ?? undefined }),
        });
      } else if (channel === "note") {
        r = await fetch("/api/crm/deal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: dealId,
            logActivity: { type: "note", subject: noteTitle.trim() ? `📝 ${noteTitle.trim()}` : "📝 Note", body: text },
          }),
        });
      }
      const d = await r?.json().catch(() => ({}));
      if (!r?.ok || d?.error) throw new Error(d?.error ?? `HTTP ${r?.status}`);
      setBody("");
      setSubject("");
      setNoteTitle("");
      setAttachIds([]);
      setReplyToActivityId(null);
      setChannel(null);
      flashOk(channel === "note" ? "Note saved ✓" : "Sent ✓");
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

  // Tighter padding so all buttons (incl. Note) fit one row.
  const btnStyle: React.CSSProperties = { justifyContent: "center", width: "100%", padding: "8px 6px", fontSize: 13.5, whiteSpace: "nowrap" };

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Floating buttons — no card, low visual weight. */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${hideCall ? 4 : 5}, 1fr)`, gap: 6 }}>
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
          className="btn"
          style={btnStyle}
          disabled={!phone}
          title={phone ?? "No phone on contact"}
          onClick={() => {
            // Messenger-style: open the conversation in the chat dock (history
            // included) instead of a blind one-shot composer.
            if (phone) openChat({ phone, name: contact?.name ?? null, dealId });
          }}
        >
          💬 Text
        </button>
        <button
          className={`btn ${channel === "whatsapp" ? "primary" : ""}`}
          style={btnStyle}
          disabled={!email}
          title={email ?? "Needs an email to find the Klaviyo profile"}
          onClick={() => switchChannel("whatsapp")}
        >
          🟢 WhatsApp
        </button>
        <button
          className={`btn ${channel === "email" ? "primary" : ""}`}
          style={btnStyle}
          disabled={!email}
          title={email ?? "No email on contact"}
          onClick={() => switchChannel("email")}
        >
          ✉️ Email
        </button>
        <button
          className={`btn ${channel === "note" ? "primary" : ""}`}
          style={btnStyle}
          title="Add a note to the deal"
          onClick={() => switchChannel("note")}
        >
          📝 Note
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

      {/* ── Floating call panel: live controls during the call, then the same
             disposition flow as the dialer — one popup, bottom-right. ── */}
      {((callState && !callState.startsWith("error")) || awaitingDispo) && (
        <div
          style={{
            position: "fixed",
            right: 18,
            bottom: 18,
            zIndex: 8600,
            width: "min(400px, 92vw)",
            boxShadow: "0 10px 34px rgba(0,0,0,0.4)",
            borderRadius: 12,
          }}
          className="card"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 20 }}>📞</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 750, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {contact?.name?.trim() || phone}
              </div>
              <div style={{ fontSize: 12.5, color: callState === "active" ? "var(--good)" : "var(--text-3)" }}>
                {callState === "active"
                  ? `On call · ${mmss(callSec)}`
                  : callState
                    ? "Ringing…"
                    : "Call ended — log it"}
              </div>
            </div>
            {callState === "active" && (
              <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 13 }} onClick={toggleMute} title={muted ? "Unmute" : "Mute"}>
                {muted ? "🔇 Muted" : "🎤 Mute"}
              </button>
            )}
            {callState && (
              <button className="btn" style={{ padding: "6px 14px", fontSize: 13.5, background: "var(--crit)", color: "#fff" }} onClick={endCall}>
                {callState === "active" ? "⏹ End" : "✕ Cancel"}
              </button>
            )}
          </div>

          {/* Disposition — appears when the call wraps, same flow as the dialer. */}
          {awaitingDispo && !pendingDispo && (
            <>
              <div style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 6 }}>How did the call go?</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DISPOSITIONS.map(([key, label]) => (
                  <button key={key} className="btn" style={{ padding: "7px 10px", fontSize: 13 }} onClick={() => setPendingDispo(key)}>
                    {label}
                  </button>
                ))}
                <button className="btn ghost" style={{ padding: "7px 10px", fontSize: 13 }} onClick={() => setAwaitingDispo(false)} title="No disposition — the call still logs via webhook">
                  Skip
                </button>
              </div>
            </>
          )}
          {awaitingDispo && pendingDispo && (
            <>
              <input
                className="vmsel"
                style={{ width: "100%", marginBottom: 8 }}
                placeholder="Add a note about this call… (optional, saves to the deal)"
                value={dispoNote}
                autoFocus
                onChange={(e) => setDispoNote(e.target.value)}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "var(--text-2)" }}>Next step?</span>
                <select className="vmsel" style={{ width: "auto", padding: "6px 8px", fontSize: 13 }} value={nextType} onChange={(e) => setNextType(e.target.value)}>
                  <option value="call">📞 Call</option>
                  <option value="task">📋 Task</option>
                  <option value="email">✉️ Email</option>
                  <option value="meeting">📅 Meeting</option>
                </select>
                <button className="btn" style={{ padding: "6px 9px", fontSize: 13 }} onClick={() => completeDispo(followUpAt(7))}>1 wk</button>
                <button className="btn" style={{ padding: "6px 9px", fontSize: 13 }} onClick={() => completeDispo(followUpAt(14))}>2 wks</button>
                <button className="btn" style={{ padding: "6px 9px", fontSize: 13 }} onClick={() => completeDispo(followUpAt(30))}>1 mo</button>
                <button className="btn" style={{ padding: "6px 9px", fontSize: 13 }} onClick={() => setShowCustomDue((v) => !v)}>📅</button>
                <button className="btn ghost" style={{ padding: "6px 9px", fontSize: 13 }} onClick={() => completeDispo(null)}>No follow-up</button>
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
              <button
                className="btn ghost"
                style={{ padding: "4px 9px", fontSize: 12, marginTop: 8 }}
                onClick={() => setPendingDispo(null)}
              >
                ← Different disposition
              </button>
            </>
          )}
        </div>
      )}

      {channel && (
        <div className="card" style={{ marginTop: 12, display: "grid", gap: 8 }}>
          {channel !== "note" && (
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
            <select
              className="vmsel"
              style={{ width: "auto", flex: 1, minWidth: 140 }}
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                if (channel === "email") setAttachIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                else appendAsset(id); // non-email: fall back to inserting the name
              }}
            >
              <option value="">🖼 Media {channel === "email" ? "attachment" : "asset"}…</option>
              {media.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          )}
          {channel === "email" && attachIds.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {attachIds.map((id) => {
                const a = media.find((x) => x.id === id);
                return (
                  <span key={id} className="chip stage" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    📎 {a?.name ?? "file"}
                    <button
                      onClick={() => setAttachIds((prev) => prev.filter((x) => x !== id))}
                      style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {channel === "email" && (
            <input
              className="vmsel"
              placeholder="Subject…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          )}
          {channel === "note" && (
            <input
              className="vmsel"
              placeholder="Title (optional)"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
            />
          )}
          {channel === "email" ? (
            <RichTextEditor value={body} onChange={setBody} placeholder={`Email ${email}…`} minHeight={110} />
          ) : channel === "note" ? (
            <MentionInput rows={4} placeholder="Note… (@name to tag a teammate)" value={body} onChange={setBody} />
          ) : (
            <textarea
              className="vmsel"
              rows={4}
              style={{ resize: "vertical" }}
              placeholder={channel === "sms" ? `Text ${phone}…` : "WhatsApp message…"}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
          {channel === "whatsapp" && waProfileId === "missing" && (
            <div style={{ color: "var(--warn)", fontSize: 13 }}>
              No Klaviyo profile found for {email} — WhatsApp needs one.
            </div>
          )}
          {err && <div style={{ color: "var(--crit)", fontSize: 13 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" disabled={(channel === "email" ? isEmptyHtml(body) : !body.trim()) || sending} onClick={send}>
              {channel === "note"
                ? sending ? "Saving…" : "Save note"
                : sending ? "Sending…" : `Send ${channel === "sms" ? "text" : channel === "whatsapp" ? "WhatsApp" : "email"}`}
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

interface CardPhone { value: string; e164?: string; primary?: boolean; bad?: boolean }
interface CardEmail { value: string; primary?: boolean }

function ContactCard({
  contact,
  phones,
  emails,
  truck,
  onSaved,
}: {
  contact: {
    id: string;
    name: string;
    first_name?: string | null;
    last_name?: string | null;
    org_name?: string | null;
    sms_consent?: string | null;
    sms_consent_at?: string | null;
    sms_consent_source?: string | null;
  };
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
              bad={!!p.bad}
              busy={busy}
              onPrimary={() => post({ op: "set_primary_phone", value: phoneKey(p) })}
              onSave={(v) => post({ op: "edit_phone", value: phoneKey(p), newValue: v })}
              onRemove={() => post({ op: "remove_phone", value: phoneKey(p) })}
              onToggleBad={() => post({ op: "toggle_bad_phone", value: phoneKey(p) })}
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
                  {p.bad ? (
                    <span style={{ color: "var(--text-3)", textDecoration: "line-through" }} title="Marked bad number — excluded from call lists">
                      {num}
                    </span>
                  ) : (
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
                  )}
                  {p.bad && <span style={{ fontSize: 11, color: "var(--crit)" }}> · bad number</span>}
                  {p.primary && !p.bad && <span style={{ fontSize: 11, color: "var(--text-3)" }}> · primary</span>}
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
            {contact.sms_consent && (
              <div
                style={{
                  fontSize: 12.5,
                  padding: "3px 0",
                  color:
                    contact.sms_consent === "opted_in"
                      ? "var(--good)"
                      : contact.sms_consent === "opted_out"
                        ? "var(--crit)"
                        : "var(--warn)",
                }}
                title={contact.sms_consent_source ? `via ${contact.sms_consent_source}` : undefined}
              >
                {contact.sms_consent === "opted_in" && "💬 Text opt-in ✓"}
                {contact.sms_consent === "declined" && "💬 Declined texts"}
                {contact.sms_consent === "opted_out" && "💬 Opted out (STOP)"}
                {contact.sms_consent_at && (
                  <span style={{ color: "var(--text-3)" }}>
                    {" · "}
                    {new Date(contact.sms_consent_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })}
                  </span>
                )}
              </div>
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
  bad,
  onPrimary,
  onSave,
  onRemove,
  onToggleBad,
}: {
  icon: string;
  value: string;
  primary: boolean;
  busy: boolean;
  bad?: boolean;
  onPrimary: () => void;
  onSave: (v: string) => void;
  onRemove: () => void;
  onToggleBad?: () => void;
}) {
  const [v, setV] = useState(value);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <input
        className="vmsel"
        style={{ flex: 1, textDecoration: bad ? "line-through" : undefined, color: bad ? "var(--text-3)" : undefined }}
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button
        className="btn ghost"
        style={{ padding: "4px 9px", fontSize: 12, color: primary ? "var(--accent)" : undefined }}
        title={primary ? "Primary" : "Make primary"}
        disabled={busy || primary}
        onClick={onPrimary}
      >
        {primary ? "★" : "☆"}
      </button>
      {onToggleBad && (
        <button
          className="btn ghost"
          style={{ padding: "4px 9px", fontSize: 12, color: bad ? "var(--crit)" : undefined }}
          title={bad ? "Bad number — click to restore" : "Mark as bad number (excludes from lists)"}
          disabled={busy}
          onClick={onToggleBad}
        >
          🚫
        </button>
      )}
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
