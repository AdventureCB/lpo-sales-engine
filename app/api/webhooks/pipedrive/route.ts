import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { env } from "@/lib/env";
import { upsertContact, upsertDeal } from "@/lib/crm-sync";
import crypto from "node:crypto";

export const runtime = "nodejs";

/**
 * Pipedrive webhooks → CRM mirror (incremental, costs zero API budget).
 * Registered with basic auth: user "lpo", password PIPEDRIVE_WEBHOOK_SECRET.
 * Handles person/deal create + change events; deletes are recorded to sync
 * state for later review rather than destructively mirrored.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const expected =
    "Basic " + Buffer.from(`lpo:${env("PIPEDRIVE_WEBHOOK_SECRET")}`).toString("base64");
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const entity: string = payload?.meta?.entity ?? payload?.meta?.object ?? "";
  const action: string = payload?.meta?.action ?? "";
  const data = payload?.data ?? payload?.current ?? null;
  const db = supabaseAdmin();

  try {
    if (!data && action !== "delete") return NextResponse.json({ ok: true, ignored: "no data" });
    if (entity === "person" && action !== "delete") {
      await upsertContact(db, data);
    } else if (entity === "deal" && action !== "delete") {
      // Live changes emit automation events; the bulk importer does not.
      await upsertDeal(db, data, { emitEvents: true });
    } else if (action === "delete") {
      await db.from("crm_sync_state").upsert(
        {
          key: `deleted:${entity}:${payload?.meta?.entity_id ?? payload?.previous?.id ?? "?"}`,
          value: { at: new Date().toISOString() },
        },
        { onConflict: "key" }
      );
    } else {
      return NextResponse.json({ ok: true, ignored: entity });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("pipedrive webhook mirror failed", e);
    // 200 anyway — Pipedrive retries hard on failures and the importer
    // reconciles anything missed.
    return NextResponse.json({ ok: false });
  }
}
