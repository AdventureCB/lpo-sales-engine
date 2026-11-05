import "server-only";
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findContact, normEmail, normPhone, processIntake, type IntakeSource } from "./intake";
import { dealOwnerEmail } from "./campaigns";

/**
 * Ops → Sales Engine events (contract: docs/ops-integration.md).
 *
 * Ops (lone-peak-ops.vercel.app) pushes signed batches of events about quotes
 * to /api/webhooks/ops; /api/cron/ops-reconcile pulls the same events nightly
 * from Ops' cursor endpoint to catch anything a delivery missed. Both feed
 * processOpsEvents(), which is idempotent on event_id.
 *
 * What an event does here (Kyle 10/7 + 11/5):
 *   quote.created/updated → ops_quotes mirror row, deal value, timeline line;
 *                           no matching deal → the "Quote Created" intake engine
 *   quote.activity        → timeline ONLY (one line per visit, updated with
 *                           dwell + sections) — never an engagement signal;
 *                           owner notified on first view, pay click, accept,
 *                           and a view after 24+ quiet hours
 *   quote.paid            → stage "Deposit Placed" (Confirmation pipeline),
 *                           amount on the timeline, owner notified, ANY active
 *                           campaign enrollment for the deal exits — never
 *                           auto-won, a rep confirms
 *   email.*               → timeline lines (actor "ops", so they never count as
 *                           a rep's manual touch)
 *   production.status     → ops_quotes + timeline, owner notified
 */

export const OPS_BASE = "https://lone-peak-ops.vercel.app";
export const OPS_PULL_URL = `${OPS_BASE}/api/crm/events`;
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
  data: Record<string, any>;
}

export type OpsResult = { event_id: string; status: "accepted" | "duplicate" | "error" | "dry"; deal_id?: string | null; detail?: string };

// ── Signature ────────────────────────────────────────────────────────────────

export function verifyOpsSignature(rawBody: string, sigHeader: string | null, tsHeader: string | null): { ok: boolean; error?: string } {
  const secret = process.env.OPS_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: "OPS_WEBHOOK_SECRET not configured" };
  if (!sigHeader || !tsHeader) return { ok: false, error: "missing signature headers" };
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_S) return { ok: false, error: "stale timestamp" };
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(sigHeader.trim());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "bad signature" };
  return { ok: true };
}

// ── Validation ───────────────────────────────────────────────────────────────

const KNOWN_TYPES = new Set(["quote.created", "quote.updated", "quote.activity", "quote.paid", "email.sent", "email.opened", "email.clicked", "production.status", "demo.completed"]);

export interface OpsOriginator { name?: string | null; email?: string | null; organization?: string | null; role?: string | null }
const LPO_ORG = /lone ?peak/i;
/** Who made the quote, from the new `originator` object or the legacy `created_by` email. */
function originatorOf(d: Record<string, any>, prev?: any): OpsOriginator | null {
  const o = d.originator && typeof d.originator === "object" ? d.originator : null;
  if (o && (o.name || o.email || o.organization)) return { name: o.name ?? null, email: o.email ? String(o.email).toLowerCase() : null, organization: o.organization ?? null, role: o.role ?? null };
  if (d.created_by && d.created_by !== "builder") return { name: null, email: String(d.created_by).toLowerCase(), organization: /@lonepeakoverland\.com$/i.test(d.created_by) ? "Lone Peak Overland" : null, role: null };
  return prev?.originator ?? null;
}
const originatorLabel = (o: OpsOriginator | null) => (o ? [o.name ?? o.email?.split("@")[0], o.organization].filter(Boolean).join(" · ") : "");
const isExternalOrg = (o: OpsOriginator | null) => !!o?.organization && !LPO_ORG.test(o.organization);

export function validateOpsEvent(e: any): string | null {
  if (!e || typeof e !== "object") return "event must be an object";
  if (typeof e.event_id !== "string" || !e.event_id || e.event_id.length > 64) return "event_id required (≤64 chars)";
  if (typeof e.type !== "string" || !e.type) return "type required";
  if (typeof e.occurred_at !== "string" || Number.isNaN(Date.parse(e.occurred_at))) return "occurred_at must be ISO-8601";
  if (typeof e.quote_id !== "string" || !e.quote_id || e.quote_id.length > 64) return "quote_id required (≤64 chars)";
  if (e.crm_deal_id != null && (typeof e.crm_deal_id !== "string" || e.crm_deal_id.length > 64)) return "crm_deal_id must be a string or null";
  if (!e.data || typeof e.data !== "object") return "data object required";
  if (e.type === "quote.created" && !normEmail(e.customer?.email)) return "customer.email required on quote.created";
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
const qLabel = (q: { quote_number?: string | null; quote_id: string }) => q.quote_number || q.quote_id;

async function ownerFor(db: SupabaseClient, dealId: string | null): Promise<string | null> {
  if (!dealId) return null;
  const { data: d } = await db.from("crm_deals").select("owner_email, owner_pipedrive_id").eq("id", dealId).maybeSingle();
  return d ? dealOwnerEmail(db, d) : null;
}

/** Deal for an event: explicit crm_deal_id → the quote's stored deal → open deal for the customer (email, then phone). */
async function resolveDeal(db: SupabaseClient, e: OpsEvent, quote: any | null): Promise<{ dealId: string | null; contactId: string | null }> {
  const tryDeal = async (id: string | null | undefined) => {
    if (!id) return null;
    const { data } = await db.from("crm_deals").select("id, contact_id").eq("id", id).maybeSingle();
    return data ?? null;
  };
  const byId = (await tryDeal(e.crm_deal_id)) ?? (await tryDeal(quote?.crm_deal_id));
  if (byId) return { dealId: byId.id, contactId: byId.contact_id };
  const email = normEmail(e.customer?.email ?? quote?.customer?.email);
  const phone = normPhone(e.customer?.phone ?? quote?.customer?.phone);
  if (!email && !phone) return { dealId: null, contactId: quote?.contact_id ?? null };
  // Email first, then phone — findContact already prefers email.
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

// ── Main ─────────────────────────────────────────────────────────────────────

export async function processOpsEvents(db: SupabaseClient, events: OpsEvent[], opts: { dry?: boolean; via?: "webhook" | "pull" } = {}): Promise<{ accepted: number; duplicates: number; errors: number; results: OpsResult[] }> {
  const out = { accepted: 0, duplicates: 0, errors: 0, results: [] as OpsResult[] };
  const { data: engineRow } = await db.from("intake_sources").select("*").eq("adapter", "ops_quote").limit(1).maybeSingle();
  const engine = (engineRow ?? null) as IntakeSource | null;

  // Oldest first so a quote's created → activity → paid land in order.
  const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  for (const e of ordered) {
    const bad = validateOpsEvent(e);
    if (bad) { out.errors++; out.results.push({ event_id: e?.event_id ?? "?", status: "error", detail: bad }); continue; }
    const { data: seen } = await db.from("ops_events").select("event_id").eq("event_id", e.event_id).maybeSingle();
    if (seen) { out.duplicates++; out.results.push({ event_id: e.event_id, status: "duplicate" }); continue; }
    if (opts.dry) { out.accepted++; out.results.push({ event_id: e.event_id, status: "dry", detail: KNOWN_TYPES.has(e.type) ? `would process ${e.type}` : `unknown type ${e.type} — stored only` }); continue; }

    try {
      const r = await applyEvent(db, e, engine);
      await db.from("ops_events").insert({
        event_id: e.event_id, type: e.type, quote_id: e.quote_id, occurred_at: e.occurred_at, crm_deal_id: r.dealId,
        payload: e, via: opts.via ?? "webhook", result: r.result ?? null, notify_email: r.notify?.email ?? null, notify_title: r.notify?.title ?? null,
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

async function applyEvent(db: SupabaseClient, e: OpsEvent, engine: IntakeSource | null): Promise<{ dealId: string | null; result?: Record<string, unknown>; notify?: { email: string; title: string } | null; detail?: string }> {
  const { data: quote } = await db.from("ops_quotes").select("*").eq("quote_id", e.quote_id).maybeSingle();
  let { dealId, contactId } = await resolveDeal(db, e, quote);
  const d = e.data ?? {};
  const label = qLabel({ quote_number: e.quote_number ?? quote?.quote_number, quote_id: e.quote_id });
  const name = customerName(e.customer) ?? customerName(quote?.customer) ?? "the customer";
  let notify: { email: string; title: string } | null = null;
  let detail: string | undefined;

  // A quote with no deal: create one through the Quote Created engine
  // (only on created/updated/paid — a stray view for an unknown quote just
  // updates the mirror).
  if (!dealId && (e.type === "quote.created" || e.type === "quote.updated" || e.type === "quote.paid")) {
    const email = normEmail(e.customer?.email ?? quote?.customer?.email);
    const phone = normPhone(e.customer?.phone ?? quote?.customer?.phone);
    if (engine?.enabled && (email || phone)) {
      const r = await processIntake(db, engine, {
        externalId: `quote:${e.quote_id}`,
        email, phone, name: customerName(e.customer) ?? customerName(quote?.customer) ?? null,
        valueCents: d.total_cents ?? quote?.total_cents ?? null,
        link: d.link ?? quote?.link ?? null,
        note: [`Quote ${label} created in Ops${d.created_by ? ` by ${d.created_by === "builder" ? "the website builder" : d.created_by.split("@")[0]}` : ""}.`, d.total_cents != null ? `Total ${usd(d.total_cents)}${d.deposit_cents ? ` · deposit ${usd(d.deposit_cents)}` : ""}.` : null, d.truck ? `Truck: ${d.truck}` : null, d.summary ?? null].filter(Boolean).join("\n"),
        occurredAt: e.occurred_at,
        meta: { ops_quote_id: e.quote_id, quote_number: e.quote_number ?? null, origin: d.origin ?? null, created_by: d.created_by ?? null },
      });
      if (r.dealId) { dealId = r.dealId; const { data: dl } = await db.from("crm_deals").select("contact_id").eq("id", r.dealId).maybeSingle(); contactId = dl?.contact_id ?? contactId; detail = `deal ${r.action}`; }
      else detail = `no deal (${r.action}${r.detail ? `: ${r.detail}` : ""})`;
    } else {
      detail = engine?.enabled ? "no email/phone to match or create a deal" : "Quote Created engine disabled";
    }
  }

  const base = { deal_id: dealId!, contact_id: contactId, occurred_at: e.occurred_at, meta: { quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? null } };
  const now = new Date().toISOString();

  switch (e.type) {
    case "quote.created":
    case "quote.updated": {
      const row = {
        quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? null,
        crm_deal_id: dealId ?? quote?.crm_deal_id ?? null, contact_id: contactId ?? quote?.contact_id ?? null,
        customer: e.customer ?? quote?.customer ?? null,
        link: d.link ?? quote?.link ?? null, total_cents: d.total_cents ?? quote?.total_cents ?? null, deposit_cents: d.deposit_cents ?? quote?.deposit_cents ?? null,
        currency: d.currency ?? quote?.currency ?? "USD", status: d.status ?? quote?.status ?? null, origin: d.origin ?? quote?.origin ?? null,
        created_by: d.created_by ?? d.originator?.email ?? quote?.created_by ?? null, originator: originatorOf(d, quote),
        truck: d.truck ?? quote?.truck ?? null, summary: d.summary ?? quote?.summary ?? null,
        version: d.version ?? quote?.version ?? null,
        quote_created_at: e.type === "quote.created" ? e.occurred_at : (quote?.quote_created_at ?? e.occurred_at),
        updated_at: now,
      };
      await db.from("ops_quotes").upsert(row, { onConflict: "quote_id" });
      if (dealId) {
        // The quote is the truth of the deal's value.
        if (d.total_cents != null) await db.from("crm_deals").update({ value_cents: d.total_cents, ...(d.truck && !quote?.truck ? {} : {}), updated_at: now }).eq("id", dealId);
        const changed = e.type === "quote.updated" && quote && (quote.status !== row.status || quote.total_cents !== row.total_cents || quote.link !== row.link);
        const orig = row.originator as OpsOriginator | null;
        const external = isExternalOrg(orig);
        if (e.type === "quote.created" || !quote || changed) {
          await timeline(db, {
            ...base, type: "note",
            subject: e.type === "quote.created" || !quote ? `🧾 Quote ${label} created${d.total_cents != null ? ` — ${usd(d.total_cents)}` : ""}${orig ? ` · by ${originatorLabel(orig)}` : d.origin === "builder" ? " · from the website builder" : ""}`
              : `🧾 Quote ${label} updated — ${row.status ?? "?"}${row.total_cents != null ? ` · ${usd(row.total_cents)}` : ""}${row.version ? ` · v${row.version}` : ""}`,
            body: [external ? `⚠️ Quoted by ${orig!.organization} — another team is working this deal; coordinate with them before reaching out.` : null, row.deposit_cents ? `Deposit ${usd(row.deposit_cents)}` : null, row.truck ? `Truck: ${row.truck}` : null, row.summary ?? null, row.link ?? null].filter(Boolean).join("\n") || null,
          });
        }
        // News to the owner: a builder-made quote, or one from another
        // organization (ambassador / installer) — a rep's own quote isn't.
        const owner = await ownerFor(db, dealId);
        if (e.type === "quote.created" && owner) {
          if (external) notify = { email: owner, title: `🧾 ${orig!.organization} quoted ${name} (${label}${d.total_cents != null ? ` · ${usd(d.total_cents)}` : ""}) — they're working this deal` };
          else if (d.origin === "builder") notify = { email: owner, title: `🧾 ${name} built a quote on the website (${label}${d.total_cents != null ? ` · ${usd(d.total_cents)}` : ""})` };
        }
      }
      return { dealId, notify, detail, result: { mirrored: true } };
    }

    case "quote.activity": {
      const action = String(d.action ?? "");
      const session = d.session_id ? String(d.session_id) : null;
      const occurredMs = Date.parse(e.occurred_at);
      if (action === "viewed") {
        const prevLast = quote?.last_viewed_at ? Date.parse(quote.last_viewed_at) : null;
        const firstEver = !quote?.first_viewed_at;
        await db.from("ops_quotes").upsert({
          quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? null, crm_deal_id: dealId ?? quote?.crm_deal_id ?? null, contact_id: contactId ?? quote?.contact_id ?? null,
          view_count: (quote?.view_count ?? 0) + 1, first_viewed_at: quote?.first_viewed_at ?? e.occurred_at,
          last_viewed_at: !prevLast || occurredMs > prevLast ? e.occurred_at : quote.last_viewed_at,
          status: quote?.status && ["draft", "sent"].includes(quote.status) ? "viewed" : quote?.status ?? null, updated_at: now,
        }, { onConflict: "quote_id" });
        if (dealId) {
          await timeline(db, { ...base, subject: `👀 ${name} viewed quote ${label}`, body: d.referrer ? `From ${String(d.referrer).replace(/^https?:\/\//, "").split("/")[0]}` : null, meta: { ...base.meta, ops_session: session, ops_action: "viewed" } });
          const owner = await ownerFor(db, dealId);
          if (owner && firstEver) notify = { email: owner, title: `👀 ${name} opened quote ${label} for the first time` };
          else if (owner && prevLast && occurredMs - prevLast > QUIET_VIEW_H * 3_600_000) notify = { email: owner, title: `👀 ${name} is back on quote ${label} after ${Math.round((occurredMs - prevLast) / 86_400_000) || 1}d` };
        }
      } else if (action === "dwell" || action === "section_opened") {
        // Fold into the visit's line instead of adding one per section/dwell.
        if (dealId && session) {
          const { data: visit } = await db.from("crm_activities").select("id, subject, body").eq("deal_id", dealId).contains("meta", { ops_session: session, ops_action: "viewed" }).order("occurred_at", { ascending: false }).limit(1).maybeSingle();
          if (visit) {
            const patch: Record<string, unknown> = {};
            if (action === "dwell" && d.duration_s) patch.subject = `${visit.subject.replace(/ · \d+m? ?\d*s$/, "")} · ${fmtDur(Number(d.duration_s))}`;
            if (action === "section_opened" && d.detail) patch.body = [visit.body, `Opened: ${d.detail}`].filter(Boolean).join("\n");
            if (Object.keys(patch).length) await db.from("crm_activities").update(patch).eq("id", visit.id);
          }
        }
      } else if (dealId) {
        const subjects: Record<string, string> = {
          pdf_downloaded: `📄 ${name} downloaded quote ${label}`,
          pay_clicked: `💳 ${name} clicked Pay ${d.detail === "full" ? "in full" : "deposit"} on quote ${label}`,
          accepted: `✅ ${name} accepted quote ${label}`,
          declined: `🚫 ${name} declined quote ${label}${d.detail ? ` — ${d.detail}` : ""}`,
          shared: `↗️ ${name} shared quote ${label}`,
        };
        const subject = subjects[action] ?? `Quote ${label}: ${action}`;
        await timeline(db, { ...base, subject, meta: { ...base.meta, ops_session: session, ops_action: action } });
        if (action === "accepted") await db.from("ops_quotes").update({ status: "accepted", updated_at: now }).eq("quote_id", e.quote_id);
        const owner = await ownerFor(db, dealId);
        if (owner && (action === "pay_clicked" || action === "accepted" || action === "declined")) notify = { email: owner, title: subject };
      }
      return { dealId, notify, detail, result: { action } };
    }

    case "quote.paid": {
      const amount = Number(d.amount_cents ?? 0);
      const kind = String(d.kind ?? "deposit");
      await db.from("ops_quotes").upsert({
        quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? null, crm_deal_id: dealId ?? quote?.crm_deal_id ?? null, contact_id: contactId ?? quote?.contact_id ?? null,
        paid_cents: (quote?.paid_cents ?? 0) + amount, last_paid_at: d.paid_at ?? e.occurred_at, status: "paid",
        total_cents: d.total_cents ?? quote?.total_cents ?? null, updated_at: now,
      }, { onConflict: "quote_id" });
      if (!dealId) return { dealId, detail: detail ?? "paid quote with no deal", result: { paid: amount } };
      const subject = `💰 ${name} paid ${usd(amount)} ${kind === "full" ? "in full" : kind} on quote ${label}`;
      await timeline(db, { ...base, subject, body: [d.method ? `Method: ${d.method}${d.processor ? ` (${d.processor})` : ""}` : null, d.balance_cents != null ? `Balance remaining: ${usd(d.balance_cents)}` : null, d.processor_ref ? `Ref: ${d.processor_ref}` : null].filter(Boolean).join("\n") || null, meta: { ...base.meta, ops_action: "paid", amount_cents: amount, kind } });
      // Stage: Deposit Placed (Confirmation pipeline) for ANY payment — a rep
      // confirms; never auto-won. Reopen a closed deal first.
      const paidStage = (engine?.config as any)?.paid_stage_id as string | undefined;
      const { data: deal } = await db.from("crm_deals").select("id, status, stage_id").eq("id", dealId).maybeSingle();
      if (deal) {
        const patch: Record<string, unknown> = { updated_at: now };
        if (deal.status !== "open") { patch.status = "open"; patch.lost_at = null; patch.lost_reason = null; }
        if (paidStage && deal.stage_id !== paidStage) { patch.stage_id = paidStage; patch.stage_changed_at = now; }
        if (d.total_cents != null) patch.value_cents = d.total_cents;
        await db.from("crm_deals").update(patch).eq("id", dealId);
        if (patch.stage_id) await timeline(db, { ...base, subject: "Moved to Deposit Placed — review and confirm", occurred_at: now, meta: { ...base.meta, ops_action: "stage" } });
      }
      // Money down ends any drip.
      const { data: enrs } = await db.from("campaign_enrollments").select("id, campaign_id").eq("deal_id", dealId).eq("status", "active");
      for (const en of enrs ?? []) {
        await db.from("campaign_enrollments").update({ status: "exited", exited_at: now, exit_reason: "deposit placed", hold_reason: null }).eq("id", en.id);
        await db.from("campaign_sends").update({ status: "skipped", error: "campaign exited: deposit placed" }).eq("enrollment_id", en.id).in("status", ["draft", "approved"]);
        const { data: c } = await db.from("campaigns").select("name").eq("id", en.campaign_id).maybeSingle();
        await timeline(db, { ...base, subject: `📣 Campaign "${c?.name ?? ""}" ended — deposit placed`, actor: "campaign", occurred_at: now, meta: { campaign_id: en.campaign_id } });
      }
      const owner = await ownerFor(db, dealId);
      if (owner) notify = { email: owner, title: subject };
      return { dealId, notify, detail, result: { paid: amount, kind, stage: paidStage ?? null, campaigns_exited: enrs?.length ?? 0 } };
    }

    case "email.sent":
    case "email.opened":
    case "email.clicked": {
      if (!dealId) return { dealId, detail: detail ?? "email event with no deal" };
      const subj = d.subject ? String(d.subject) : `Ops email${d.template ? ` (${d.template})` : ""}`;
      if (e.type === "email.sent") {
        await timeline(db, { ...base, type: "email", subject: `📤 Ops sent: ${subj}`, body: d.to ? `To ${d.to}${d.from ? ` from ${d.from}` : ""}` : null, meta: { ...base.meta, direction: "outbound", ops_message_id: d.message_id ?? null, template: d.template ?? null } });
      } else {
        await timeline(db, { ...base, subject: e.type === "email.opened" ? `📬 ${name} opened Ops email: ${subj}` : `🔗 ${name} clicked a link in Ops email: ${subj}`, body: e.type === "email.clicked" && d.url ? String(d.url) : null, meta: { ...base.meta, ops_message_id: d.message_id ?? null } });
      }
      return { dealId, detail, result: { email: e.type } };
    }

    case "production.status": {
      await db.from("ops_quotes").upsert({
        quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? null, crm_deal_id: dealId ?? quote?.crm_deal_id ?? null, contact_id: contactId ?? quote?.contact_id ?? null,
        production_status: d.status ?? null, production_label: d.label ?? null, production_eta: d.eta ?? null, updated_at: now,
      }, { onConflict: "quote_id" });
      if (!dealId) return { dealId, detail: detail ?? "production event with no deal" };
      const subject = `🏭 ${d.label ?? d.status ?? "Production update"}${d.eta ? ` · ETA ${d.eta}` : ""} (quote ${label})`;
      await timeline(db, { ...base, subject, body: d.note ?? null, meta: { ...base.meta, ops_action: "production", production_status: d.status ?? null } });
      const owner = await ownerFor(db, dealId);
      if (owner) notify = { email: owner, title: subject };
      return { dealId, notify, detail, result: { production: d.status ?? null } };
    }

    case "demo.completed": {
      // Another organization (ambassador / installer) reports a demo for this
      // quote's customer. Recorded on the quote + timeline; owner notified.
      const demo = { organization: d.organization ?? d.originator?.organization ?? null, by: d.by ?? d.originator?.name ?? d.originator?.email ?? null, at: d.demo_at ?? e.occurred_at, note: d.note ?? null, location: d.location ?? null };
      const demos = Array.isArray(quote?.demos) ? [...quote.demos, demo] : [demo];
      await db.from("ops_quotes").upsert({
        quote_id: e.quote_id, quote_number: e.quote_number ?? quote?.quote_number ?? null, crm_deal_id: dealId ?? quote?.crm_deal_id ?? null, contact_id: contactId ?? quote?.contact_id ?? null,
        demos, updated_at: now,
      }, { onConflict: "quote_id" });
      if (!dealId) return { dealId, detail: detail ?? "demo event with no deal", result: { demo } };
      const subject = `🚙 Demo done${demo.organization ? ` by ${demo.organization}` : ""}${demo.by ? ` (${demo.by})` : ""} — quote ${label}`;
      await timeline(db, { ...base, type: "meeting", subject, body: [demo.location ? `Where: ${demo.location}` : null, demo.note].filter(Boolean).join("\n") || null, occurred_at: demo.at, meta: { ...base.meta, ops_action: "demo", organization: demo.organization } });
      const owner = await ownerFor(db, dealId);
      if (owner) notify = { email: owner, title: subject };
      return { dealId, notify, detail, result: { demo } };
    }

    default:
      // Unknown types are stored (ops_events) but not acted on — contract §5.
      return { dealId, detail: `unknown type ${e.type} — stored only` };
  }
}

// ── Nightly reconcile (pull) ─────────────────────────────────────────────────

export async function reconcileFromOps(db: SupabaseClient, opts: { limit?: number; maxPages?: number } = {}) {
  const secret = process.env.OPS_WEBHOOK_SECRET;
  if (!secret) return { error: "OPS_WEBHOOK_SECRET not configured" };
  const { data: cur } = await db.from("crm_sync_state").select("value").eq("key", "ops_pull_cursor").maybeSingle();
  let cursor: string | null = (cur?.value as any)?.next ?? null;
  const totals = { pages: 0, events: 0, accepted: 0, duplicates: 0, errors: 0 };
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const url = new URL(OPS_PULL_URL);
    if (cursor) url.searchParams.set("since", cursor);
    url.searchParams.set("limit", String(opts.limit ?? 500));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000) });
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
