import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/cron";
import { envOptional } from "@/lib/env";
import { ingestTypeformResponse } from "@/lib/typeform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manual backfill from the Typeform Responses API — recovers submissions
 * the webhook (or the old Zap) missed. Needs TYPEFORM_API_TOKEN (personal
 * token, responses:read + forms:read). Runs each response through the same
 * ingest as the live webhook, so re-running is safe.
 *
 *   ?since=2026-08-07            start of the window (required)
 *   &form=wkFcnrYc               one form id (default: every enabled
 *                                typeform engine's configured form id)
 */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const token = envOptional("TYPEFORM_API_TOKEN");
  if (!token) return NextResponse.json({ error: "TYPEFORM_API_TOKEN not set" }, { status: 400 });

  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  if (!since || Number.isNaN(Date.parse(since)))
    return NextResponse.json({ error: "?since=YYYY-MM-DD required" }, { status: 400 });
  const sinceIso = new Date(since).toISOString();

  const db = supabaseAdmin();
  let formIds: string[];
  const one = url.searchParams.get("form");
  if (one) formIds = [one];
  else {
    const { data: engines } = await db
      .from("intake_sources")
      .select("config")
      .eq("adapter", "typeform")
      .eq("enabled", true);
    formIds = [...new Set((engines ?? []).map((e: any) => e.config?.typeform_form_id).filter(Boolean))] as string[];
  }
  if (formIds.length === 0) return NextResponse.json({ error: "no form ids configured" }, { status: 400 });

  const headers = { Authorization: `Bearer ${token}` };
  const out: Record<string, any> = {};

  for (const formId of formIds) {
    // Form definition (title + flattened fields) — the Responses API items
    // don't carry one, and ingest needs it for answer titles + form name.
    const formRes = await fetch(`https://api.typeform.com/forms/${formId}`, { headers });
    if (!formRes.ok) {
      out[formId] = { error: `form fetch ${formRes.status}` };
      continue;
    }
    const form = await formRes.json();
    const flat: any[] = [];
    const walk = (fields: any[]) => {
      for (const f of fields ?? []) {
        flat.push({ id: f.id, ref: f.ref, title: f.title });
        if (f.properties?.fields) walk(f.properties.fields);
      }
    };
    walk(form.fields ?? []);
    const definition = { title: form.title ?? null, fields: flat };

    const actions: Record<string, number> = {};
    let fetched = 0;
    let before: string | null = null;
    for (;;) {
      const qs = new URLSearchParams({ since: sinceIso, page_size: "200", completed: "true" });
      if (before) qs.set("before", before);
      const r = await fetch(`https://api.typeform.com/forms/${formId}/responses?${qs}`, { headers });
      if (!r.ok) {
        out[formId] = { error: `responses fetch ${r.status}`, fetched, actions };
        break;
      }
      const page = await r.json();
      const items: any[] = page.items ?? [];
      for (const item of items) {
        fetched++;
        try {
          const res = await ingestTypeformResponse(db, {
            event_type: "form_response",
            event_id: item.token,
            form_response: { ...item, form_id: formId, definition },
          });
          const key = res.intakeAction ?? "no_intake";
          actions[key] = (actions[key] ?? 0) + 1;
        } catch (e) {
          actions.ingest_error = (actions.ingest_error ?? 0) + 1;
          console.error(`backfill ingest failed (${formId}/${item.token})`, e);
        }
      }
      if (items.length < 200) {
        out[formId] = { formTitle: form.title, fetched, actions };
        break;
      }
      before = items[items.length - 1]?.token ?? null;
      if (!before) {
        out[formId] = { formTitle: form.title, fetched, actions };
        break;
      }
    }
  }

  return NextResponse.json({ since: sinceIso, forms: out });
}
