import "server-only";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findContact, normEmail, normPhone, processIntake, type IntakeSource } from "./intake";
import { dealOwnerEmail } from "./campaigns";

/**
 * Ops → Sales Engine events (contract v2: docs/ops-integration.md).
 *
 * Ops (ops.lonepeakoverland.com) pushes signed batches of events about quotes
 * to /api/webhooks/ops; /api/cron/ops-reconcile pulls the same events nightly
 * from Ops' cursor endpoint. Both feed processOpsEvents(), idempotent on
 * event_id. `backfill: true` events (the launch replay of historical quotes)
 * are recorded silently: mirror + timeline on an EXISTING deal only — no new
 * deals, stage moves, campaign exits, owner changes or notifications.
 *
 * Decisions (Kyle 10/7, 11/5, 11/16):
 *   - quote activity is timeline-only, never an engagement signal
 *   - a quote EMAILED to the customer (ops_stage "sent") → Ops owns follow-up:
 *     the person leaves Sales Engine drips and can't be auto-enrolled again
 *   - first payment (deposit / full) → Confirmation pipeline "Deposit Placed",
 *     campaigns exit, and the deal owner is asked to APPROVE Ops' rep credit
 *     or FLAG it for an admin. Later payments (balance / additions / split)
 *     are timeline only — they never move a stage.
 *   - Ops' rep vs our owner: pool deal → adopt Ops' rep; otherwise a mismatch
 *     before payment is flagged on the deal (owner notified), never changed
 */

export const OPS_BASE = "https://ops.lonepeakoverland.com";
export const OPS_PULL_URL = `${OPS_BASE}/api/crm/events`;
export const OPS_PREFILL_URL = `${OPS_BASE}/api/crm/prefill`;
const QUIET_VIEW_H = 24;
const SIGNATURE_WINDOW_S = 5 * 60;

export interface OpsCustomer { name?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null }
export interface OpsEvent {
  event_id: string;
  type: string;
  occurred_at: string;
  quote_id: string;
  quote_number?: string | null;
  crm_deal_id?: string | null;
  customer?: OpsCustomer | null;
  backfill?: boolean;
  data: Record<string, any>;
}
export interface OpsOriginator { name?: string | null; email?: string | null; organization?: string | null; role?: string | null }
export type OpsResult = { event_id: string; status: "accepted" | "duplicate" | "error" | "dry"; deal_id?: string | null; detail?: string };

// ── Signing (v2: HMAC over "<timestamp>.<raw body>") ─────────────────────────

export function signOps(rawBody: string, ts: string): string {
  return "sha256=" + crypto.createHmac("sha256", process.env.OPS_WEBHOOK_SECRET ?? "").update(`${ts}.${rawBody}`, "utf8").digest("base64");
}

export function verifyOpsSignature(rawBody: string, sigHeader: string | null, tsHeader: string | null): { ok: boolean; error?: string } {
  if (!process.env.OPS_WEBHOOK_SECRET) return { ok: false, error: "OPS_WEBHOOK_SECRET not configured" };
  if (!sigHeader || !tsHeader) return { ok: false, error: "missing signature headers" };
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_S) return { ok: false, error: "stale timestamp" };
  const a = Buffer.from(signOps(rawBody, tsHeader.trim()));
  const b = Buffer.from(sigHeader.trim());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "bad signature" };
  return { ok: true };
}

// ── Validation ───────────────────────────────────────────────────────────────

const KNOWN_TYPES = new Set([
  "quote.created", "quote.updated", "quote.activity", "quote.paid", "quote.refunded", "quote.cancelled", "quote.attention",
  "email.sent", "email.delivered", "email.bounced", "production.status", "install.booked", "demo.completed",
]);

export function validateOpsEvent(e: any): string | null {
  if (!e || typeof e !== "object") return "event must be an object";
  if (typeof e.event_id !== "string" || !e.event_id || e.event_id.length > 64) return "event_id required (≤64 chars)";
  if (typeof e.type !== "string" || !e.type) return "type required";
  if (typeof e.occurred_at !== "string" || Number.isNaN(Date.parse(e.occurred_at))) return "occurred_at must be ISO-8601";
  if (typeof e.quote_id !== "string" || !e.quote_id || e.quote_id.length > 64) return "quote_id required (≤64 chars)";
  if (e.crm_deal_id != null && (typeof e.crm_deal_id !== "string" || e.crm_deal_id.length > 64)) return "crm_deal_id must be a string or null";
  if (!e.data || typeof e.data !== "object") return "data object required";
  // v2 (1.4a): email may be null — but a new quote needs SOMETHING to match on.
  if (e.type === "quote.created" && !e.crm_deal_id && !normEmail(e.customer?.email) && !normPhone(e.customer?.phone) && !e.data?.website_submission_id)
    return "quote.created needs crm_deal_id, customer.email, customer.phone or data.website_submission_id";
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const usd = (cents: number | null | undefined) => (cents == null ? "" : `$${Math.round(cents / 100).toLocaleString()}`);
const fmtDur = (s: number | null | undefined) => {
  if (!s || s < 1) return "";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m}m ${r}s` : `${r}s`;
};
const customerName = (c?: OpsCustomer | null) => (c?.name?.trim() || [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() || null);
const LPO_ORG = /lone ?peak/i;
const STAGE_LABEL: Record<string, string> = {
  started: "started", sent: "sent", invoice_out: "invoice out", deposit_paid: "deposit paid", paid: "paid in full",
  additions_owed: "additions owed", expired: "expired", deleted: "deleted", cancelled: "cancelled",
};
function originatorOf(d: Record<string, any>, prev?: any): OpsOriginator | null {
  const o = d.originator && typeof d.originator === "object" ? d.originator : null;
  if (o && (o.name || o.email || o.organization)) return { name: o.name ?? null, email: o.email ? String(o.email).toLowerCase() : null, organization: o.organization ?? null, role: o.role ?? null };
  if (d.created_by && d.created_by !== "builder") return { name: null, email: String(d.created_by).toLowerCase(), organization: /@lonepeakoverland\.com$/i.test(d.created_by) ? "Lone Peak Overland" : null, role: null };
  return prev?.originator ?? null;
}
const originatorLabel = (o: OpsOriginator | null) => (o ? [o.name ?? o.email?.split("@")[0], o.organization].filter(Boolean).join(" · ") : "");
const isExternalOrg = (o: OpsOriginator | null) => !!o?.organization && !LPO_ORG.test(o.organization);

async function ownerFor(db: SupabaseClient, dealId: string | null): Promise<string | null> {
  if (!dealId) return null;
  const { data: d } = await db.from("crm_deals").select("owner_email, owner_pipedrive_id").eq("id", dealId).maybeSingle();
  return d ? dealOwnerEmail(db, d) : null;
}
async function adminEmails(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("app_users").select("email").eq("role", "admin");
  return (data ?? []).map((r: any) => String(r.email).toLowerCase()).filter(Boolean);
}

/** Deal for an event: crm_deal_id → the quote's deal → website survey submission → open deal by email, then phone. */
async function resolveDeal(db: SupabaseClient, e: OpsEvent, quote: any | null): Promise<{ dealId: string | null; contactId: string | null }> {
  const tryDeal = async (id: string | null | undefined) => {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await db.from("crm_deals").select("id, contact_id").eq("id", id).maybeSingle();
    return data ?? null;
  };
  const byId = (await tryDeal(e.crm_deal_id)) ?? (await tryDeal(quote?.crm_deal_id));
  if (byId) return { dealId: byId.id, contactId: byId.contact_id };
  const subId = e.data?.website_submission_id ?? quote?.website_submission_id;
  if (subId) {
    // Website forms use their submission_id as the intake external id.
    const { data: ie } = await db.from("intake_events").select("deal_id").eq("external_id", String(subId)).not("deal_id", "is", null).limit(1).maybeSingle();
    const d = await tryDeal(ie?.deal_id);
    if (d) return { dealId: d.id, contactId: d.contact_id };
  }
  const email = normEmail(e.customer?.email ?? quote?.customer?.email);
  const phone = normPhone(e.customer?.phone ?? quote?.customer?.phone);
  if (!email && !phone) return { dealId: null, contactId: quote?.contact_id ?? null };
  const contact = await findContact(db, email, phone);
  if (!contact) return { dealId: null, contactId: null };
  const { data: open } = await db.from("crm_deals").select("id").eq("contact_id", contact.id).eq("status", "open").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return { dealId: open?.id ?? null, contactId: contact.id };
}

async function timeline(db: SupabaseClient, row: { deal_id: string; contact_id: string | null; type?: string; subject: string; body?: string | null; actor?: string; occurred_at: string; meta?: Record<string, unknown> }) {
  const { data } = await db.from("crm_activities").insert({
    deal_id: row.deal_id, contact_id: row.contact_id, type: row.type ?? "system", subject: row.subject, body: row.body ?? null,
    actor: row.actor ?? "ops", occurred_at: row.occurred_at, meta: { ops: true, ...(row.meta ?? {}) },
  }).select("id").single();
  return data?.id ?? null;
}

/** End every active Sales Engine campaign for the deal (Ops owns follow-up / money is down). */
async function exitCampaigns(db: SupabaseClient, dealId: string, contactId: string | null, reason: string): Promise<number> {
  const { data: enrs } = await db.from("campaign_enrollments").select("id, campaign_id").eq("deal_id", dealId).eq("status", "active");
  const now = new Date().toISOString();
  for (const en of enrs ?? []) {
    await db.from("campaign_enrollments").update({ status: "exited", exited_at: now, exit_reason: reason, hold_reason: null }).eq("id", en.id);
    await db.from("campaign_sends").update({ status: "skipped", error: `campaign exited: ${reason}` }).eq("enrollment_id", en.id).in("status", ["draft", "approved"]);
    const { data: c } = await db.from("campaigns").select("name").eq("id", en.campaign_id).maybeSingle();
    await timeline(db, { deal_id: dealId, contact_id: contactId, subject: `📣 Campaign "${c?.name ?? ""}" ended — ${reason}`, actor: "campaign", occurred_at: now, meta: { campaign_id: en.campaign_id } });
  }
  return enrs?.length ?? 0;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function processOpsEvents(db: SupabaseClient, events: OpsEvent[], opts: { dry?: boolean; via?: "webhook" | "pull" } = {}): Promise<{ accepted: number; duplicates: number; errors: number; results: OpsResult[] }> {
  const out = { accepted: 0, duplicates: 0, errors: 0, results: [] as OpsResult[] };
  const { data: engineRow } = await db.from("intake_sources").select("*").eq("adapter", "ops_quote").limit(1).maybeSingle();
  const engine = (engineRow ?? null) as IntakeSource | null;

  const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  for (const e of ordered) {
    const bad = validateOpsEvent(e);
    if (bad) { out.errors++; out.results.push({ event_id: e?.event_id ?? "?", status: "error", detail: bad }); continue; }
    const { data: seen } = await db.from("ops_events").select("event_id").eq("event_id", e.event_id).maybeSingle();
    if (seen) { out.duplicates++; out.results.push({ event_id: e.event_id, status: "duplicate" }); continue; }
    if (opts.dry) { out.accepted++; out.results.push({ event_id: e.event_id, status: "dry", detail: KNOWN_TYPES.has(e.type) ? `would process ${e.type}${e.backfill ? " (backfill, silent)" : ""}` : `unknown type ${e.type} — stored only` }); continue; }
    try {
      const r = await applyEvent(db, e, engine);
      await db.from("ops_events").insert({
        event_id: e.event_id, type: e.type, quote_id: e.quote_id, occurred_at: e.occurred_at, crm_deal_id: r.dealId,
        payload: e, via: opts.via ?? "webhook", result: r.result ?? null,
        notify_email: e.backfill ? null : r.notify?.email ?? null, notify_title: e.backfill ? null : r.notify?.title ?? null,
      });
      out.accepted++;
      out.results.push({ event_id: e.event_id, status: "accepted", deal_id: r.dealId, detail: r.detail });
    } catch (err) {
      out.errors++;
      out.results.push({ event_id: e.event_id, status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

type Applied = { dealId: string | null; result?: Record<string, unknown>; notify?: { email: string; title: string } | null; detail?: string };

async function applyEvent(db: SupabaseClient, e: OpsEvent, engine: IntakeSource | null): Promise<Applied> {
  const silent = e.backfill === true;
  const { data: quote } = await db.from("ops_quotes").select("*").eq("quote_id", e.quote_id).maybeSingle();
  let { dealId, contactId } = await resolveDeal(db, e, quote);
  const d = e.data ?? {};
  const label = e.quote_number || quote?.quote_number || e.quote_id;
  const name = customerName(e.customer) ?? customerName(quote?.customer) ?? "the customer";
  let notify: { email: string; title: string } | null = null;
  let detail: string | undefined;
  let justCreated = false;
  const now = new Date().toISOString();

  // No deal: the Quote Created engine makes one — never for backfill.
  if (!dealId && !silent && (e.type === "quote.created" || e.type === "quote.updated" || e.type === "quote.paid")) {
    const email = normEmail(e.customer?.email ?? quote?.customer?.email);
    const phone = normPhone(e.customer?.phone ?? quote?.customer?.phone);
    if (engine?.enabled && (email || phone)) {
      const r = await processIntake(db, engine, {
        externalId: `quote:${e.quote_id}`,
        email, phone, name: customerName(e.customer) ?? customerName(quote?.customer) ?? null,
        valueCents: d.total_cents ?? d.subtotal_cents ?? quote?.total_cents ?? null,
        link: d.link ?? quote?.link ?? null,
        note: [
          `Quote ${label} created in Ops${d.origin === "builder" ? ` from the website${d.source ? ` (${d.source})` : ""}` : ""}.`,
          d.subtotal_cents != null ? `Subtotal ${usd(d.subtotal_cents)}${d.total_cents != null ? ` · total ${usd(d.total_cents)}` : ""}.` : null,
          d.build?.truck ? `Truck: ${d.build.truck}` : null,
        ].filter(Boolean).join("\n"),
        occurredAt: e.occurred_at,
        meta: { ops_quote_id: e.quote_id, origin: d.origin ?? null, source: d.source ?? null },
      });
      if (r.dealId) { dealId = r.dealId; const { data: dl } = await db.from("crm_deals").select("contact_id").eq("id", r.dealId).maybeSingle(); contactId = dl?.contact_id ?? contactId; detail = `deal ${r.action}`; justCreated = r.action === "created"; }
      else detail = `no deal (${r.action}${r.detail ? `: ${r.detail}` : ""})`;
    } else detail = engine?.enabled ? "no email/phone to match or create a deal" : "Quote Created engine disabled";
  }
  if (!dealId && silent) detail = "backfill: no existing deal — mirrored only";

  const base = { deal_id: dealId!, contact_id: contactId, occurred_at: e.occurred_at, meta: { quote_id: e.quote_id } };
  const mirror = async (fields: Record<string, unknown>) =>
    db.from("ops_quotes").upsert({
      quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? e.quote_id,
      crm_deal_id: dealId ?? quote?.crm_deal_id ?? null, contact_id: contactId ?? quote?.contact_id ?? null, updated_at: now, ...fields,
    }, { onConflict: "quote_id" });

  switch (e.type) {
    case "quote.created":
    case "quote.updated": {
      const orig = originatorOf(d, quote);
      const stage = d.ops_stage ?? quote?.ops_stage ?? null;
      const firstSent = stage === "sent" && !quote?.sent_at;
      await mirror({
        customer: e.customer ?? quote?.customer ?? null,
        link: d.link ?? quote?.link ?? null,
        subtotal_cents: d.subtotal_cents ?? quote?.subtotal_cents ?? null,
        total_cents: "total_cents" in d ? d.total_cents : quote?.total_cents ?? null,
        deposit_cents: d.deposit_cents ?? quote?.deposit_cents ?? null,
        paid_cents: d.paid_cents ?? quote?.paid_cents ?? 0,
        balance_cents: "balance_cents" in d ? d.balance_cents : quote?.balance_cents ?? null,
        currency: d.currency ?? quote?.currency ?? "USD",
        status: d.status ?? quote?.status ?? null, ops_stage: stage,
        origin: d.origin ?? quote?.origin ?? null, created_by: orig?.email ?? quote?.created_by ?? null, originator: orig,
        truck: d.build?.truck ?? quote?.truck ?? null, build: d.build ?? quote?.build ?? null,
        expires_at: "expires_at" in d ? d.expires_at : quote?.expires_at ?? null,
        balance_due_on: "balance_due_on" in d ? d.balance_due_on : quote?.balance_due_on ?? null,
        rep: "rep" in d ? d.rep : quote?.rep ?? null,
        website_submission_id: d.website_submission_id ?? quote?.website_submission_id ?? null,
        version: d.build?.revision ?? quote?.version ?? null,
        sent_at: quote?.sent_at ?? (stage === "sent" ? e.occurred_at : null),
        quote_created_at: e.type === "quote.created" ? e.occurred_at : quote?.quote_created_at ?? e.occurred_at,
      });
      if (!dealId) return { dealId, detail, result: { mirrored: true } };

      const external = isExternalOrg(orig);
      const changed = e.type === "quote.updated" && quote && (quote.ops_stage !== stage || quote.total_cents !== (d.total_cents ?? quote.total_cents));
      if (!silent && (d.total_cents != null || d.subtotal_cents != null)) await db.from("crm_deals").update({ value_cents: d.total_cents ?? d.subtotal_cents, updated_at: now }).eq("id", dealId);
      if ((e.type === "quote.created" || !quote || changed) && (!justCreated || external)) {
        await timeline(db, {
          ...base, type: "note",
          subject: e.type === "quote.created" || !quote
            ? `🧾 Quote ${label} created${d.subtotal_cents != null ? ` — ${usd(d.total_cents ?? d.subtotal_cents)}` : ""}${orig ? ` · by ${originatorLabel(orig)}` : d.origin === "builder" ? " · from the website" : ""}`
            : `🧾 Quote ${label} — ${STAGE_LABEL[stage] ?? stage ?? "updated"}${d.total_cents != null ? ` · ${usd(d.total_cents)}` : ""}`,
          body: [external ? `⚠️ Quoted by ${orig!.organization} — another team is working this deal; coordinate with them before reaching out.` : null, d.build?.truck ? `Truck: ${d.build.truck}` : null, d.expires_at ? `Expires ${d.expires_at}` : null].filter(Boolean).join("\n") || null,
        });
      }
      // What the customer changed in their build (4.1) — timeline only.
      if (d.change?.summary) await timeline(db, { ...base, subject: `🛠 ${d.change.by === "customer" ? `${name} changed their build` : `Build changed by ${d.change.by ?? "Ops"}`}: ${String(d.change.summary).slice(0, 200)}`, meta: { ...base.meta, ops_action: "build_change" } });

      if (silent) return { dealId, detail, result: { mirrored: true, backfill: true } };

      // Quote emailed → Ops owns follow-up; Sales Engine drips stop (Kyle 11/16).
      let exited = 0;
      if (firstSent) exited = await exitCampaigns(db, dealId, contactId, "quote sent — Ops handles follow-up");

      // Rep alignment (Kyle 11/16): pool deal adopts Ops' rep; a mismatch on
      // an owned deal is flagged (before payment), never changed.
      const owner = await ownerFor(db, dealId);
      const opsRep = d.rep?.email ? String(d.rep.email).toLowerCase() : null;
      if (opsRep) {
        const { data: rp } = await db.from("reps").select("pipedrive_user_id, name").eq("email", opsRep).maybeSingle();
        if (!owner && rp?.pipedrive_user_id != null) {
          await db.from("crm_deals").update({ owner_pipedrive_id: rp.pipedrive_user_id, updated_at: now }).eq("id", dealId);
          await timeline(db, { ...base, subject: `👤 Owner set to ${rp.name ?? opsRep} — the rep on Ops quote ${label}`, occurred_at: now });
        } else if (owner && owner !== opsRep && !(quote?.paid_cents > 0)) {
          if (quote?.owner_mismatch?.ops_rep !== opsRep) {
            await mirror({ owner_mismatch: { ops_rep: opsRep, deal_owner: owner, at: now } });
            await timeline(db, { ...base, subject: `⚠️ Ops credits ${d.rep?.name ?? opsRep} on quote ${label}, but this deal is owned by ${owner.split("@")[0]}`, occurred_at: now, meta: { ...base.meta, ops_action: "owner_mismatch" } });
            notify = { email: owner, title: `⚠️ Ops credits ${d.rep?.name ?? opsRep.split("@")[0]} on ${name}'s quote ${label} — you own the deal` };
          }
        } else if (quote?.owner_mismatch) await mirror({ owner_mismatch: null });
      }
      if (!notify && e.type === "quote.created" && owner) {
        if (external) notify = { email: owner, title: `🧾 ${orig!.organization} quoted ${name} (${label}) — they're working this deal` };
        else if (d.origin === "builder") notify = { email: owner, title: `🧾 ${name} started a quote on the website (${label})` };
      }
      return { dealId, notify, detail, result: { mirrored: true, campaigns_exited: exited } };
    }

    case "quote.activity": {
      const action = String(d.action ?? "");
      const session = d.session_id ? String(d.session_id) : null;
      const occurredMs = Date.parse(e.occurred_at);
      if (action === "viewed") {
        const prevLast = quote?.last_viewed_at ? Date.parse(quote.last_viewed_at) : null;
        const firstEver = !quote?.first_viewed_at;
        await mirror({ view_count: (quote?.view_count ?? 0) + 1, first_viewed_at: quote?.first_viewed_at ?? e.occurred_at, last_viewed_at: !prevLast || occurredMs > prevLast ? e.occurred_at : quote.last_viewed_at });
        if (dealId) {
          const geo = d.geo && typeof d.geo === "object" ? [d.geo.city, d.geo.region].filter(Boolean).join(", ") : "";
          await timeline(db, { ...base, subject: `👀 ${name} opened their build ${label}`, body: [geo ? `From ${geo}` : null, d.referrer ? `Via ${String(d.referrer).replace(/^https?:\/\//, "").split("/")[0]}` : null].filter(Boolean).join(" · ") || null, meta: { ...base.meta, ops_session: session, ops_action: "viewed" } });
          const owner = silent ? null : await ownerFor(db, dealId);
          if (owner && firstEver) notify = { email: owner, title: `👀 ${name} opened their build ${label} for the first time` };
          else if (owner && prevLast && occurredMs - prevLast > QUIET_VIEW_H * 3_600_000) notify = { email: owner, title: `👀 ${name} is back on their build ${label} after ${Math.round((occurredMs - prevLast) / 86_400_000) || 1}d` };
        }
      } else if (action === "dwell") {
        if (dealId && session && d.duration_s) {
          const { data: visit } = await db.from("crm_activities").select("id, subject").eq("deal_id", dealId).contains("meta", { ops_session: session, ops_action: "viewed" }).order("occurred_at", { ascending: false }).limit(1).maybeSingle();
          if (visit) await db.from("crm_activities").update({ subject: `${visit.subject.replace(/ · \d+m? ?\d*s$/, "")} · ${fmtDur(Number(d.duration_s))}` }).eq("id", visit.id);
        }
      } else if (dealId) {
        const subject = action === "pay_clicked" ? `💳 ${name} clicked Pay ${d.detail === "full" ? "in full" : d.detail === "additions" ? "for additions" : "deposit"} on ${label}` : `Quote ${label}: ${action}`;
        await timeline(db, { ...base, subject, meta: { ...base.meta, ops_session: session, ops_action: action } });
        const owner = silent ? null : await ownerFor(db, dealId);
        if (owner && action === "pay_clicked") notify = { email: owner, title: subject };
      }
      return { dealId, notify, detail, result: { action } };
    }

    case "quote.paid": {
      const amount = Number(d.amount_cents ?? 0);
      const kind = String(d.kind ?? "deposit");
      const firstPayment = !(quote?.paid_cents > 0) && (kind === "deposit" || kind === "full");
      await mirror({ paid_cents: (quote?.paid_cents ?? 0) + amount, last_paid_at: d.paid_at ?? e.occurred_at, status: "paid", ops_stage: kind === "full" || d.balance_cents === 0 || quote?.ops_stage === "paid" ? "paid" : "deposit_paid", total_cents: d.total_cents ?? quote?.total_cents ?? null, balance_cents: d.balance_cents ?? quote?.balance_cents ?? null });
      if (!dealId) return { dealId, detail: detail ?? "paid quote with no deal", result: { paid: amount } };
      const kindLabel = ({ deposit: "deposit", full: "in full", balance: "balance", additions: "for additions", split: "split payment" } as Record<string, string>)[kind] ?? kind;
      const subject = `💰 ${name} paid ${usd(amount)} ${kindLabel} on ${label}`;
      await timeline(db, { ...base, subject, body: [d.processor_ref ? `Shopify order ${d.processor_ref}` : null, d.balance_cents != null ? `Balance remaining: ${usd(d.balance_cents)}` : null].filter(Boolean).join("\n") || null, meta: { ...base.meta, ops_action: "paid", amount_cents: amount, kind } });
      if (silent) return { dealId, detail, result: { paid: amount, kind, backfill: true } };

      let stageMoved = false, exited = 0;
      if (firstPayment) {
        // Deposit Placed (Confirmation pipeline) for review — but never pull a
        // won deal backwards.
        const paidStage = (engine?.config as any)?.paid_stage_id as string | undefined;
        const { data: deal } = await db.from("crm_deals").select("id, status, stage_id").eq("id", dealId).maybeSingle();
        if (deal && deal.status !== "won") {
          const patch: Record<string, unknown> = { updated_at: now };
          if (deal.status !== "open") { patch.status = "open"; patch.lost_at = null; patch.lost_reason = null; }
          if (paidStage && deal.stage_id !== paidStage) { patch.stage_id = paidStage; patch.stage_changed_at = now; stageMoved = true; }
          if (d.total_cents != null) patch.value_cents = d.total_cents;
          await db.from("crm_deals").update(patch).eq("id", dealId);
          if (stageMoved) await timeline(db, { ...base, subject: "Moved to Deposit Placed — review and confirm", occurred_at: now, meta: { ...base.meta, ops_action: "stage" } });
        }
      }
      exited = await exitCampaigns(db, dealId, contactId, "deposit placed");

      const owner = await ownerFor(db, dealId);
      if (firstPayment) {
        // Credit review (Kyle 11/16): the owner approves Ops' rep credit or flags it.
        const opsRep = quote?.rep?.email ? String(quote.rep.email).toLowerCase() : null;
        await mirror({ credit_review: { status: "pending", ops_rep: opsRep, ops_rep_name: quote?.rep?.name ?? null, deal_owner: owner, at: now }, owner_mismatch: null });
        await timeline(db, {
          ...base, type: "task", occurred_at: now, actor: owner ?? "ops",
          subject: `🧾 Confirm sale credit on ${label}: Ops credits ${quote?.rep?.name ?? opsRep ?? "no rep"} — approve or flag on the Quotes card`,
          meta: { ...base.meta, ops_action: "credit_review" },
        });
        if (owner) notify = { email: owner, title: `💰 ${name} paid on ${label} — confirm the sale credit (Ops: ${quote?.rep?.name ?? opsRep ?? "no rep"})` };
      } else if (owner) notify = { email: owner, title: subject };
      return { dealId, notify, detail, result: { paid: amount, kind, stage_moved: stageMoved, campaigns_exited: exited } };
    }

    case "quote.refunded":
    case "quote.cancelled": {
      const amount = Number(d.amount_cents ?? d.refunded_cents ?? 0);
      await mirror(e.type === "quote.cancelled"
        ? { status: "void", ops_stage: "cancelled", cancelled_at: d.cancelled_at ?? e.occurred_at, refunded_cents: (quote?.refunded_cents ?? 0) + amount }
        : { refunded_cents: (quote?.refunded_cents ?? 0) + amount });
      if (!dealId) return { dealId, detail: detail ?? "no deal" };
      const subject = e.type === "quote.cancelled"
        ? `🛑 ${name} cancelled their camper (${label}) — ${usd(d.refunded_cents)} refunded${d.retained_cents ? `, ${usd(d.retained_cents)} retained` : ""}`
        : `↩️ Refund ${usd(amount)} on ${label}${d.reason === "line_removed" ? " — item removed" : d.reason === "cancellation" ? " — cancellation" : ""}`;
      await timeline(db, { ...base, subject, body: d.processor_ref ? `Shopify ${d.processor_ref}` : null, meta: { ...base.meta, ops_action: e.type } });
      const owner = silent ? null : await ownerFor(db, dealId);
      if (owner) notify = { email: owner, title: subject };
      return { dealId, notify, detail };
    }

    case "quote.attention": {
      const kind = String(d.kind ?? "attention");
      const att = { ...(quote?.attention ?? {}), [kind]: { open: d.open !== false, detail: d.detail ?? null, at: e.occurred_at } };
      if (d.open === false) delete (att as any)[kind];
      await mirror({ attention: Object.keys(att).length ? att : null });
      if (!dealId) return { dealId, detail: detail ?? "no deal" };
      const what = kind === "truck_answer_needed" ? "Truck question holding production" : kind === "refund_requested" ? "Customer asked for a refund" : kind.replace(/_/g, " ");
      const subject = d.open === false ? `✅ Cleared: ${what} (${label})` : `🚧 ${what} — ${label}${d.detail ? `: ${d.detail}` : ""}`;
      await timeline(db, { ...base, subject, meta: { ...base.meta, ops_action: "attention", kind } });
      const owner = silent ? null : await ownerFor(db, dealId);
      if (owner && d.open !== false) notify = { email: owner, title: subject };
      return { dealId, notify, detail };
    }

    case "email.sent":
    case "email.delivered":
    case "email.bounced": {
      if (!dealId) return { dealId, detail: detail ?? "email event with no deal" };
      const subj = d.subject ? String(d.subject) : `Ops email${d.template ? ` (${d.template})` : ""}`;
      if (e.type === "email.sent") {
        await timeline(db, { ...base, type: "email", subject: `📤 Ops sent: ${subj}`, body: d.to ? `To ${d.to}${d.from ? ` from ${d.from}` : ""}` : null, meta: { ...base.meta, direction: "outbound", ops_message_id: d.message_id ?? null, template: d.template ?? null } });
      } else if (e.type === "email.bounced") {
        await timeline(db, { ...base, subject: `⛔ Ops email bounced: ${subj}`, body: d.to ? `${d.to} looks dead` : null, meta: { ...base.meta, ops_message_id: d.message_id ?? null } });
        // Mark the address bad on the contact (like a bad phone).
        const to = normEmail(d.to);
        if (to && contactId) {
          const { data: c } = await db.from("crm_contacts").select("emails").eq("id", contactId).maybeSingle();
          const emails = ((c?.emails as any[]) ?? []).map((x) => (String(x.value ?? "").toLowerCase() === to ? { ...x, bad: true, bad_at: now } : x));
          await db.from("crm_contacts").update({ emails }).eq("id", contactId);
        }
        const owner = silent ? null : await ownerFor(db, dealId);
        if (owner) notify = { email: owner, title: `⛔ ${name}'s email bounced (${d.to ?? "address"}) — get a good address` };
      }
      // email.delivered: stored only (ops_events) — not worth a timeline line.
      return { dealId, notify, detail, result: { email: e.type } };
    }

    case "production.status": {
      await mirror({ production_status: d.status ?? null, production_label: d.label ?? null, production_eta: d.eta ?? null, eta_label: d.eta_label ?? quote?.eta_label ?? null, ...("balance_due_on" in d ? { balance_due_on: d.balance_due_on } : {}) });
      if (!dealId) return { dealId, detail: detail ?? "production event with no deal" };
      const subject = `🏭 ${d.label ?? d.status ?? "Production update"}${d.area ? ` · ${d.area}` : ""}${d.eta_label ? ` · ${d.eta_label}` : ""} (${label})`;
      await timeline(db, { ...base, subject, body: d.reason ? `Reason: ${d.reason}` : d.note ?? null, meta: { ...base.meta, ops_action: "production", production_status: d.status ?? null } });
      const owner = silent ? null : await ownerFor(db, dealId);
      if (owner && ["scheduled", "on_hold", "ready", "delivered", "cancelled"].includes(String(d.status))) notify = { email: owner, title: subject };
      return { dealId, notify, detail, result: { production: d.status ?? null } };
    }

    case "install.booked": {
      await mirror({ install: { day: d.day ?? null, time: d.time ?? null, booked_by: d.booked_by ?? null, moved: !!d.moved } });
      if (!dealId) return { dealId, detail: detail ?? "no deal" };
      await timeline(db, { ...base, subject: `📅 Install ${d.moved ? "moved to" : "booked for"} ${d.day ?? "?"}${d.time ? ` ${d.time}` : ""} (${label}, by ${d.booked_by ?? "?"})`, meta: { ...base.meta, ops_action: "install" } });
      return { dealId, detail };
    }

    case "demo.completed": {
      // Future feature (Ops hasn't built it); handled so it works when they do.
      const demo = { organization: d.organization ?? d.originator?.organization ?? null, by: d.by ?? d.originator?.name ?? d.originator?.email ?? null, at: d.demo_at ?? e.occurred_at, note: d.note ?? null, location: d.location ?? null };
      await mirror({ demos: Array.isArray(quote?.demos) ? [...quote.demos, demo] : [demo] });
      if (!dealId) return { dealId, detail: detail ?? "demo event with no deal", result: { demo } };
      const subject = `🚙 Demo done${demo.organization ? ` by ${demo.organization}` : ""}${demo.by ? ` (${demo.by})` : ""} — ${label}`;
      await timeline(db, { ...base, type: "meeting", subject, body: [demo.location ? `Where: ${demo.location}` : null, demo.note].filter(Boolean).join("\n") || null, occurred_at: demo.at, meta: { ...base.meta, ops_action: "demo", organization: demo.organization } });
      const owner = silent ? null : await ownerFor(db, dealId);
      if (owner) notify = { email: owner, title: subject };
      return { dealId, notify, detail, result: { demo } };
    }

    default:
      return { dealId, detail: `unknown type ${e.type} — stored only` };
  }
}

// ── Credit review (owner approves / flags Ops' rep credit) ───────────────────

export async function reviewCredit(db: SupabaseClient, quoteId: string, user: { email: string; role: string }, action: "approve" | "flag", note?: string | null): Promise<{ ok: boolean; error?: string }> {
  const { data: q } = await db.from("ops_quotes").select("*").eq("quote_id", quoteId).maybeSingle();
  if (!q?.credit_review || !q.crm_deal_id) return { ok: false, error: "nothing to review" };
  const owner = await ownerFor(db, q.crm_deal_id);
  if (user.role !== "admin" && owner !== user.email) return { ok: false, error: "only the deal owner or an admin can review this" };
  const now = new Date().toISOString();
  const cr = { ...q.credit_review, status: action === "approve" ? "approved" : "flagged", by: user.email, reviewed_at: now, note: note?.trim() || null };
  await db.from("ops_quotes").update({ credit_review: cr, updated_at: now }).eq("quote_id", quoteId);
  const label = q.quote_number || quoteId;
  const repName = q.credit_review.ops_rep_name ?? q.credit_review.ops_rep ?? "no rep";
  // Close the review task.
  await db.from("crm_activities").update({ done_at: now }).eq("deal_id", q.crm_deal_id).contains("meta", { ops_action: "credit_review", quote_id: quoteId }).is("done_at", null);
  if (action === "approve") {
    await db.from("crm_activities").insert({ deal_id: q.crm_deal_id, contact_id: q.contact_id, type: "system", subject: `✅ Sale credit on ${label} approved for ${repName}`, actor: user.email, occurred_at: now, meta: { ops: true, quote_id: quoteId } });
  } else {
    const admins = (await adminEmails(db)).filter((a) => a !== user.email);
    await db.from("crm_activities").insert({
      deal_id: q.crm_deal_id, contact_id: q.contact_id, type: "note", actor: user.email, occurred_at: now,
      subject: `🚩 Sale credit flagged on ${label}`,
      body: `${admins.map((a) => `@${a.split("@")[0]}`).join(" ")} Ops credits ${repName}; ${user.email.split("@")[0]} says that's wrong.${note?.trim() ? ` Note: ${note.trim()}` : ""} Reassign the credit in Ops if needed.`,
      meta: { ops: true, quote_id: quoteId, mentions: admins },
    });
  }
  return { ok: true };
}

// ── Deep-link prefill (v2 1.1: customer details go server-to-server) ───────

export async function opsPrefill(dealId: string, customer: OpsCustomer): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.OPS_WEBHOOK_SECRET) return { ok: false, error: "OPS_WEBHOOK_SECRET not configured" };
  const body = JSON.stringify({ crm_deal_id: dealId, customer });
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    const res = await fetch(OPS_PREFILL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ops-signature": signOps(body, ts), "x-ops-timestamp": ts },
      body, signal: AbortSignal.timeout(6000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `ops prefill ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "prefill failed" };
  }
}

// ── Nightly reconcile (pull) ─────────────────────────────────────────────────

export async function reconcileFromOps(db: SupabaseClient, opts: { limit?: number; maxPages?: number } = {}) {
  const token = process.env.OPS_PULL_TOKEN;
  if (!token) return { skipped: "OPS_PULL_TOKEN not configured" };
  const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", "ops_pull_cursor").maybeSingle();
  let cursor: string | null = (cur?.value as any)?.next ?? null;
  const totals = { pages: 0, events: 0, accepted: 0, duplicates: 0, errors: 0 };
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const url = new URL(OPS_PULL_URL);
    if (cursor) url.searchParams.set("since", cursor);
    url.searchParams.set("limit", String(opts.limit ?? 500));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ...totals, error: `ops pull ${res.status}` };
    const body = (await res.json()) as { events?: OpsEvent[]; next?: string | null; has_more?: boolean };
    const events = Array.isArray(body.events) ? body.events : [];
    totals.pages++; totals.events += events.length;
    if (events.length) {
      const r = await processOpsEvents(db, events, { via: "pull" });
      totals.accepted += r.accepted; totals.duplicates += r.duplicates; totals.errors += r.errors;
    }
    if (body.next) { cursor = String(body.next); await db.from("crm_sync_state").upsert({ key: "ops_pull_cursor", value: { next: cursor, at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: "key" }); }
    if (!body.has_more || !events.length) break;
  }
  return { ok: true, cursor, ...totals };
}
