import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase";
import {
  buildContext,
  conditionsPass,
  executeAction,
  triggerMatches,
  type Automation,
  type CrmEvent,
} from "@/lib/automations";

export const runtime = "nodejs";
export const maxDuration = 60;

const BATCH = 50;

/** Per-minute engine tick: process queued events against enabled automations. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const db = supabaseAdmin();

  const { data: events } = await db
    .from("crm_events")
    .select("id, type, payload")
    .is("processed_at", null)
    .order("created_at")
    .limit(BATCH);
  if (!events || events.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  const { data: automations } = await db
    .from("crm_automations")
    .select("id, name, trigger, conditions, actions")
    .eq("enabled", true);
  const autos = (automations ?? []) as Automation[];

  let processed = 0;
  let runs = 0;
  for (const event of events as CrmEvent[]) {
    if (Date.now() - started > 45_000) break;
    const matching = autos.filter((a) => triggerMatches(a, event));
    if (matching.length > 0) {
      const ctx = await buildContext(db, event);
      for (const auto of matching) {
        if (!conditionsPass(auto.conditions, ctx)) {
          await db.from("crm_automation_runs").insert({
            automation_id: auto.id,
            deal_id: ctx.deal?.id ?? null,
            status: "skipped",
            detail: { reason: "conditions", event: event.type },
          });
          continue;
        }
        const results: string[] = [];
        let status = "ok";
        for (const action of auto.actions) {
          try {
            results.push(await executeAction(db, action, ctx));
          } catch (e) {
            status = "error";
            results.push(`ERROR ${action.type}: ${e instanceof Error ? e.message : String(e)}`);
            break; // stop this automation's chain on failure
          }
        }
        await db.from("crm_automation_runs").insert({
          automation_id: auto.id,
          deal_id: ctx.deal?.id ?? null,
          status,
          detail: { event: event.type, results },
        });
        runs++;
      }
    }
    await db.from("crm_events").update({ processed_at: new Date().toISOString() }).eq("id", event.id);
    processed++;
  }

  return NextResponse.json({ ok: true, processed, runs, elapsedMs: Date.now() - started });
}
