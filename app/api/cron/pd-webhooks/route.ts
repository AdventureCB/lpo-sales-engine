import { NextRequest, NextResponse } from "next/server";
import { env, envOptional } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_URL = "https://lpo-sales-engine.vercel.app";

function authed(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${env("CRON_SECRET")}`;
}

async function pdV1(path: string, method = "GET", body?: unknown): Promise<any> {
  const u = new URL(`https://api.pipedrive.com/v1${path}`);
  u.searchParams.set("api_token", env("PIPEDRIVE_API_TOKEN"));
  const res = await fetch(u, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`Pipedrive ${path} ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
  }
  return json.data;
}

/** List registered Pipedrive webhooks. */
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const hooks = await pdV1("/webhooks");
  return NextResponse.json({
    webhooks: (hooks ?? []).map((h: any) => ({
      id: h.id,
      url: h.subscription_url,
      object: h.event_object,
      action: h.event_action,
      active: h.is_active ?? h.active_flag,
    })),
  });
}

/**
 * Register the mirror webhooks (person + deal, all actions) pointing at
 * /api/webhooks/pipedrive with basic auth. Idempotent — skips existing.
 */
export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!envOptional("PIPEDRIVE_WEBHOOK_SECRET")) {
    return NextResponse.json({ error: "PIPEDRIVE_WEBHOOK_SECRET not set" }, { status: 500 });
  }
  const target = `${APP_URL}/api/webhooks/pipedrive`;
  const existing = (await pdV1("/webhooks")) ?? [];
  const have = new Set(
    existing
      .filter((h: any) => h.subscription_url === target)
      .map((h: any) => `${h.event_object}:${h.event_action}`)
  );
  const created: string[] = [];
  for (const obj of ["person", "deal", "activity"]) {
    if (have.has(`${obj}:*`)) continue;
    await pdV1("/webhooks", "POST", {
      subscription_url: target,
      event_object: obj,
      event_action: "*",
      http_auth_user: "lpo",
      http_auth_password: env("PIPEDRIVE_WEBHOOK_SECRET"),
      version: "1.0",
    });
    created.push(`${obj}:*`);
  }
  return NextResponse.json({ ok: true, created, alreadyHad: [...have] });
}
