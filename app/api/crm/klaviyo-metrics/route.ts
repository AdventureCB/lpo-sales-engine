import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getMetrics, getLatestEventProps, getLists, metricSlug } from "@/lib/klaviyo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trigger catalog: every Klaviyo metric (which includes Shopify, Typeform,
 * Gorgias, API events) grouped by integration — plus, with ?sample=<id>,
 * the latest event's actual data fields for the template field picker.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const sampleId = params.get("sample");
  try {
    if (params.get("lists")) {
      return NextResponse.json({ lists: await getLists() });
    }
    if (sampleId) {
      const props = await getLatestEventProps(sampleId);
      return NextResponse.json({ sample: props ?? {} });
    }
    const metrics = await getMetrics();
    return NextResponse.json({
      metrics: metrics
        .map((m) => ({ ...m, slug: metricSlug(m.name) }))
        .sort((a, b) => (a.integration ?? "zzz").localeCompare(b.integration ?? "zzz") || a.name.localeCompare(b.name)),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
