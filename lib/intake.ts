import type { SupabaseClient } from "@supabase/supabase-js";
import { createDealFromEmail } from "./deal-create";
import { enqueuePdSync } from "./pd-sync";
import { updateDealStage } from "./pipedrive";

/**
 * Intake Engine — the native "INTAKE ENGINE" sub-zap. Every funnel adapter
 * (abandoned cart poller, Typeform webhook, Klaviyo automations) normalizes
 * its trigger into an IntakePayload and calls processIntake with its
 * configured source. Behavior is entirely config-driven (Settings):
 *
 *  - existing OPEN deal   → funnel-touch note on the original deal (re-heats:
 *    the note bumps last_activity, so Sprint Lists / recency see it)
 *  - existing CLOSED deal → note + REOPEN + round-robin assign
 *  - no deal              → create via createDealFromEmail (round-robin owner,
 *    title template, source label; payload phone skips Klaviyo enrichment)
 *
 * Idempotent by (source, externalId). Every outcome logs to intake_events
 * so migration counts reconcile against Zapier.
 */

export interface IntakeSource {
  id: string;
  channel_id: number | null;
  label: string;
  adapter: string;
  enabled: boolean;
  config: {
    sku_contains?: string;
    delay_minutes?: number;
    title_template?: string;
    enrich_phone?: boolean;
    on_existing_open?: "note" | "new_deal" | "skip";
    on_existing_closed?: "reopen_assign" | "new_deal" | "note" | "skip";
    source_name?: string;
    owner_pool?: { pipedrive_id: number; name?: string; enabled: boolean }[];
    pipedrive_stage_id?: number;
  };
}

export interface IntakePayload {
  externalId?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  valueCents?: number | null;
  link?: string | null;
  meta?: Record<string, unknown>;
}

export interface IntakeResult {
  action: "created" | "noted" | "reopened" | "skipped" | "error";
  dealId?: string | null;
  detail?: string;
}

/** Per-engine round-robin over the enabled pool reps. */
export async function nextIntakeOwner(db: SupabaseClient, source: IntakeSource): Promise<number | null> {
  const pool = (source.config.owner_pool ?? []).filter((p) => p.enabled && p.pipedrive_id);
  if (pool.length === 0) return null;
  const key = `rr:intake:${source.id}`;
  const { data } = await db.from("crm_sync_state").select("value").eq("key", key).maybeSingle();
  const idx = Number((data?.value as any)?.idx ?? -1);
  const next = (idx + 1) % pool.length;
  await db.from("crm_sync_state").upsert(
    { key, value: { idx: next }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return pool[next].pipedrive_id;
}

function normEmail(e: string | null | undefined): string | null {
  const s = e?.trim().toLowerCase();
  return s && s.includes("@") ? s : null;
}

function normPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length > 7 ? `+${digits}` : null;
}

async function findContact(db: SupabaseClient, email: string | null, phone: string | null) {
  if (email) {
    const { data } = await db
      .from("crm_contacts")
      .select("id, name")
      .filter("emails", "cs", JSON.stringify([{ value: email }]))
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await db
      .from("crm_contacts")
      .select("id, name")
      .filter("phones", "cs", JSON.stringify([{ e164: phone }]))
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

function touchNote(source: IntakeSource, payload: IntakePayload): { subject: string; body: string } {
  const bits: string[] = [];
  if (payload.valueCents != null) bits.push(`$${Math.round(payload.valueCents / 100).toLocaleString()}`);
  if (payload.link) bits.push(payload.link);
  return {
    subject: `🔁 ${source.label} — funnel touch`,
    body: bits.join("\n") || `${source.label} signal received`,
  };
}

export async function processIntake(
  db: SupabaseClient,
  source: IntakeSource,
  payload: IntakePayload
): Promise<IntakeResult> {
  const email = normEmail(payload.email);
  const phone = normPhone(payload.phone);
  const externalId = payload.externalId ? String(payload.externalId).slice(0, 120) : null;

  const log = async (r: IntakeResult) => {
    try {
      await db.from("intake_events").insert({
        source_id: source.id,
        external_id: externalId,
        email,
        phone,
        action: r.action,
        deal_id: r.dealId ?? null,
        detail: { ...(payload.meta ?? {}), note: r.detail, value_cents: payload.valueCents, link: payload.link },
      });
    } catch {} // unique violation = concurrent duplicate; outcome already logged
    return r;
  };

  if (!email && !phone) return log({ action: "error", detail: "no email or phone in payload" });

  // Idempotency: this cart/submission was already processed.
  if (externalId) {
    const { data: seen } = await db
      .from("intake_events")
      .select("id")
      .eq("source_id", source.id)
      .eq("external_id", externalId)
      .limit(1)
      .maybeSingle();
    if (seen) return { action: "skipped", detail: "duplicate external id" };
  }

  const contact = await findContact(db, email, phone);

  if (contact) {
    // Most recent deal for the contact decides the path.
    const { data: deals } = await db
      .from("crm_deals")
      .select("id, status, title, pipedrive_deal_id")
      .eq("contact_id", contact.id)
      .order("updated_at", { ascending: false })
      .limit(5);
    const open = (deals ?? []).find((d) => d.status === "open");
    const closed = (deals ?? [])[0];

    if (open) {
      const behavior = source.config.on_existing_open ?? "note";
      if (behavior === "skip") return log({ action: "skipped", dealId: open.id, detail: "open deal exists" });
      if (behavior === "note" || behavior === undefined) {
        const n = touchNote(source, payload);
        await db.from("crm_activities").insert({
          deal_id: open.id,
          contact_id: contact.id,
          type: "note",
          subject: n.subject,
          body: n.body,
          actor: "intake",
          occurred_at: new Date().toISOString(), // bumps last_activity → re-heats
        });
        if (open.pipedrive_deal_id) {
          await enqueuePdSync(db, "note", { dealId: open.pipedrive_deal_id, content: `${n.subject}\n${n.body}` });
        }
        return log({ action: "noted", dealId: open.id });
      }
      // behavior === "new_deal" falls through to creation below.
    } else if (closed && (source.config.on_existing_closed ?? "reopen_assign") === "reopen_assign") {
      const owner = await nextIntakeOwner(db, source);
      await db
        .from("crm_deals")
        .update({
          status: "open",
          lost_at: null,
          lost_reason: null,
          ...(owner ? { owner_pipedrive_id: owner } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", closed.id);
      const n = touchNote(source, payload);
      await db.from("crm_activities").insert({
        deal_id: closed.id,
        contact_id: contact.id,
        type: "note",
        subject: `♻️ Reopened via ${source.label}`,
        body: n.body,
        actor: "intake",
        occurred_at: new Date().toISOString(),
      });
      if (closed.pipedrive_deal_id) {
        const fields = { status: "open", ...(owner ? { owner_id: owner } : {}) };
        try {
          await updateDealStage(closed.pipedrive_deal_id, fields as any);
        } catch {
          await enqueuePdSync(db, "deal_update", { dealId: closed.pipedrive_deal_id, fields });
        }
        await enqueuePdSync(db, "note", { dealId: closed.pipedrive_deal_id, content: `♻️ Reopened via ${source.label}\n${n.body}` });
      }
      return log({ action: "reopened", dealId: closed.id });
    }
  }

  // No contact / no relevant deal (or explicit new_deal behavior) → create.
  if (!email) return log({ action: "error", detail: "creation requires an email (phone-only payload, no contact match)" });
  const owner = await nextIntakeOwner(db, source);
  const name = payload.name?.trim() || email.split("@")[0];
  const title = (source.config.title_template ?? `${source.label} - {name}`).replace("{name}", name);
  try {
    const result = await createDealFromEmail(db, {
      email,
      name,
      title,
      ownerPipedriveId: owner,
      pipedriveStageId: source.config.pipedrive_stage_id ?? null,
      enrichPhone: phone ? false : source.config.enrich_phone !== false,
      providedPhone: phone,
      skipIfOpenDeal: true, // safety vs races / parallel Zapier during migration
      sourceName: source.config.source_name ?? source.label,
    });
    if (!result.created) return log({ action: "skipped", detail: result.skippedReason });
    // First touch note (cart link / value) so the rep has the context.
    if ((payload.link || payload.valueCents != null) && result.crmDealId) {
      const n = touchNote(source, payload);
      await db.from("crm_activities").insert({
        deal_id: result.crmDealId,
        type: "note",
        subject: `🛒 ${source.label}`,
        body: n.body,
        actor: "intake",
        occurred_at: new Date().toISOString(),
      });
    }
    return log({ action: "created", dealId: result.crmDealId ?? null });
  } catch (e) {
    return log({ action: "error", detail: e instanceof Error ? e.message : "create failed" });
  }
}
