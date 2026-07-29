import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import { normalizeEmail } from "./identity";

/**
 * CRM automation engine: event → matching automations → actions.
 * Actions are deliberately small and composable; templates support
 * {{deal.title}}, {{contact.name}}, {{contact.first_name}}, {{event.*}}.
 */

export interface CrmEvent {
  id: string;
  type: string;
  payload: Record<string, any>;
}

export interface Automation {
  id: string;
  name: string;
  trigger: Record<string, any>;
  conditions: Array<{ field: string; op: string; value: any }>;
  actions: Array<Record<string, any>>;
}

export async function enqueueEvent(
  db: SupabaseClient,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from("crm_events").insert({ type, payload });
  if (error) console.error(`enqueue ${type} failed`, error.message);
}

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function renderTemplate(tpl: string, ctx: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = getPath(ctx, path);
    return v == null ? "" : String(v);
  });
}

export function triggerMatches(auto: Automation, event: CrmEvent): boolean {
  if (auto.trigger.type !== event.type) return false;
  if (auto.trigger.signal_type && event.payload.signal_type !== auto.trigger.signal_type) return false;
  if (auto.trigger.to_stage_id && event.payload.to_stage_id !== auto.trigger.to_stage_id) return false;
  if (auto.trigger.pipeline_id && event.payload.pipeline_id !== auto.trigger.pipeline_id) return false;
  return true;
}

export function conditionsPass(conditions: Automation["conditions"], ctx: Record<string, any>): boolean {
  for (const c of conditions ?? []) {
    const actual = getPath(ctx, c.field);
    switch (c.op) {
      case "eq": if (actual != c.value) return false; break;
      case "neq": if (actual == c.value) return false; break;
      case "gt": if (!(Number(actual) > Number(c.value))) return false; break;
      case "lt": if (!(Number(actual) < Number(c.value))) return false; break;
      case "contains": if (!String(actual ?? "").toLowerCase().includes(String(c.value).toLowerCase())) return false; break;
      case "exists": if (actual == null || actual === "") return false; break;
      case "not_exists": if (actual != null && actual !== "") return false; break;
      default: return false;
    }
  }
  return true;
}

/** Build the template/condition context for an event. */
export async function buildContext(db: SupabaseClient, event: CrmEvent): Promise<Record<string, any>> {
  const ctx: Record<string, any> = { event: event.payload };
  if (event.payload.crm_deal_id) {
    const { data: deal } = await db
      .from("crm_deals")
      .select("*, crm_contacts ( id, name, first_name, last_name, emails, phones ), crm_stages ( name )")
      .eq("id", event.payload.crm_deal_id)
      .maybeSingle();
    if (deal) {
      ctx.deal = { ...deal, stage_name: deal.crm_stages?.name };
      ctx.contact = deal.crm_contacts ?? null;
    }
  }
  if (!ctx.contact && event.payload.person_email) {
    const email = normalizeEmail(event.payload.person_email);
    if (email) {
      const { data: contact } = await db
        .from("crm_contacts")
        .select("id, name, first_name, last_name, emails, phones")
        .contains("emails", JSON.stringify([{ value: email }]))
        .maybeSingle();
      ctx.contact = contact ?? { name: email.split("@")[0], emails: [{ value: email }], phones: [] };
    }
  }
  if (ctx.contact) {
    const phones = ctx.contact.phones ?? [];
    ctx.contact.phone =
      phones.find((p: any) => p.primary && p.e164)?.e164 ?? phones.find((p: any) => p.e164)?.e164 ?? null;
    ctx.contact.email = (ctx.contact.emails ?? []).find((e: any) => e.primary)?.value ?? (ctx.contact.emails ?? [])[0]?.value ?? event.payload.person_email ?? null;
  }
  return ctx;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function actSendSms(action: Record<string, any>, ctx: Record<string, any>): Promise<string> {
  const to = action.to === "event_phone" ? ctx.event?.phone : ctx.contact?.phone;
  if (!to) throw new Error("no destination phone");
  const content = renderTemplate(action.body_template ?? "", ctx).trim();
  if (!content) throw new Error("empty message body");
  const res = await fetch("https://api.quo.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: env("QUO_API_KEY"),
      "Content-Type": "application/json",
      "User-Agent": "lpo-sales-engine/0.1",
    },
    body: JSON.stringify({ content, from: action.from ?? "PN2nRozOQb", to: [to] }),
  });
  if (!res.ok) throw new Error(`quo send ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return `sms → ${to}`;
}

/** Push a custom Klaviyo event; a Klaviyo flow keyed on it sends the email. */
async function actKlaviyoEvent(action: Record<string, any>, ctx: Record<string, any>): Promise<string> {
  const email = ctx.contact?.email;
  if (!email) throw new Error("no contact email");
  const body = {
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: action.metric_name } } },
        profile: { data: { type: "profile", attributes: { email } } },
        properties: Object.fromEntries(
          Object.entries(action.properties ?? {}).map(([k, v]) => [k, renderTemplate(String(v), ctx)])
        ),
      },
    },
  };
  const res = await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${env("KLAVIYO_PRIVATE_KEY")}`,
      revision: "2024-10-15",
      "Content-Type": "application/vnd.api+json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`klaviyo event ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return `klaviyo event "${action.metric_name}" → ${email}`;
}

async function actWebhook(action: Record<string, any>, ctx: Record<string, any>): Promise<string> {
  const res = await fetch(action.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: ctx.event, deal: ctx.deal ?? null, contact: ctx.contact ?? null }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
  return `webhook → ${action.url}`;
}

async function actAddNote(db: SupabaseClient, action: Record<string, any>, ctx: Record<string, any>): Promise<string> {
  if (!ctx.deal?.id) throw new Error("no deal in context");
  await db.from("crm_activities").insert({
    deal_id: ctx.deal.id,
    type: "note",
    body: renderTemplate(action.body_template ?? "", ctx),
    actor: "automation",
  });
  return "note added";
}

async function actCreateTask(db: SupabaseClient, action: Record<string, any>, ctx: Record<string, any>): Promise<string> {
  if (!ctx.deal?.id) throw new Error("no deal in context");
  await db.from("crm_activities").insert({
    deal_id: ctx.deal.id,
    type: "task",
    subject: renderTemplate(action.subject_template ?? "Follow up", ctx),
    actor: "automation",
    due_at: new Date(Date.now() + (action.due_in_days ?? 0) * 86400_000).toISOString(),
  });
  return "task created";
}

/**
 * Create a deal from a signal (the Zap replacement) — delegates to the
 * shared source-agnostic creator (person find/create, Klaviyo phone
 * enrichment, open-deal dedupe, immediate mirror).
 */
async function actCreateDeal(db: SupabaseClient, action: Record<string, any>, ctx: Record<string, any>): Promise<string> {
  const email = normalizeEmail(ctx.contact?.email ?? ctx.event?.person_email);
  if (!email) throw new Error("no contact email");
  const { createDealFromEmail, nextRoundRobinOwner } = await import("./deal-create");

  // Owner: fixed id, or fair rotation over a pool (add reps by adding ids).
  let ownerPipedriveId: number | null = action.owner_pipedrive_id ?? null;
  if (action.owner_strategy === "round_robin" && Array.isArray(action.owner_pool) && action.owner_pool.length > 0) {
    ownerPipedriveId = await nextRoundRobinOwner(db, action.owner_pool.map(Number));
  }

  const result = await createDealFromEmail(db, {
    email,
    name: ctx.contact?.name ?? null,
    title: action.title_template ? renderTemplate(action.title_template, ctx) : null,
    ownerPipedriveId,
    pipedriveStageId: action.pipedrive_stage_id ?? null,
    enrichPhone: action.enrich_phone_from_klaviyo !== false,
    skipIfOpenDeal: action.skip_if_open_deal !== false,
  });
  if (!result.created) return `skipped: ${result.skippedReason}`;
  return `deal created: ${result.title} (#${result.pipedriveDealId}) → owner ${ownerPipedriveId ?? "default"}${result.phoneEnriched ? " · phone enriched from Klaviyo" : ""}`;
}

export async function executeAction(
  db: SupabaseClient,
  action: Record<string, any>,
  ctx: Record<string, any>
): Promise<string> {
  switch (action.type) {
    case "send_sms": return actSendSms(action, ctx);
    case "klaviyo_event": return actKlaviyoEvent(action, ctx);
    case "webhook": return actWebhook(action, ctx);
    case "add_note": return actAddNote(db, action, ctx);
    case "create_task": return actCreateTask(db, action, ctx);
    case "create_deal": return actCreateDeal(db, action, ctx);
    default: throw new Error(`unknown action type: ${action.type}`);
  }
}
