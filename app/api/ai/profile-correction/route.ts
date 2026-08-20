import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { extractProfile } from "@/lib/ai-profiler-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Op = "archetype_wrong" | "attribute_clear" | "tag_remove" | "restore" | "note";

/**
 * Phase 5a: rep corrections. A correction is PINNED — the display updates
 * immediately AND the pin is enforced on every future profiler run (the
 * model is told, and the output is hard-filtered). `restore` lifts a pin
 * (the item returns only if a future run re-derives it).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { dealId?: string; op?: Op; kind?: string; key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { dealId, op, key } = body;
  if (!dealId || !op || !key?.trim()) {
    return NextResponse.json({ error: "dealId, op, key required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: profile } = await db.from("deal_profiles").select("*").eq("deal_id", dealId).maybeSingle();
  if (!profile) return NextResponse.json({ error: "no profile for this deal" }, { status: 404 });

  const corr = { ...((profile.corrections as any) ?? {}) };
  const list = (name: string): string[] => (Array.isArray(corr[name]) ? corr[name] : []);
  const add = (name: string, v: string) => (corr[name] = [...new Set([...list(name), v])]);
  const entry = { op, key, by: user.email, at: new Date().toISOString() };
  corr.log = [...(Array.isArray(corr.log) ? corr.log : []), entry].slice(-100);

  const patch: Record<string, unknown> = { corrections: corr, updated_at: new Date().toISOString() };

  if (op === "archetype_wrong") {
    add("archetypes_wrong", key);
    patch.archetypes = ((profile.archetypes as any[]) ?? []).filter((a) => a.key !== key);
  } else if (op === "attribute_clear") {
    add("attributes_cleared", key);
    const attrs = { ...((profile.attributes as Record<string, unknown>) ?? {}) };
    delete attrs[key];
    patch.attributes = attrs;
  } else if (op === "tag_remove") {
    add("tags_removed", key.toLowerCase());
    patch.tags = ((profile.tags as string[]) ?? []).filter((t) => t.toLowerCase() !== key.toLowerCase());
  } else if (op === "note") {
    // Free-text feedback — verified fact for every future run. Deliberate rep
    // effort, so bust the input-hash cache and re-extract NOW (budget still
    // respected) so the profile visibly absorbs it.
    const text = key.trim().slice(0, 500);
    corr.notes = [...(Array.isArray(corr.notes) ? corr.notes : []), { text, by: user.email, at: entry.at }].slice(-25);
    patch.watermark = { ...((profile.watermark as any) ?? {}), input_hash: `rep-note:${Date.now()}` };
  } else if (op === "restore") {
    // kind tells us which pin list; display returns on the next run.
    const name = { archetype: "archetypes_wrong", attribute: "attributes_cleared", tag: "tags_removed", interest: "interests_removed" }[
      body.kind ?? ""
    ];
    if (!name) return NextResponse.json({ error: "restore needs kind" }, { status: 400 });
    corr[name] = list(name).filter((v: string) => v !== key && v.toLowerCase() !== key.toLowerCase());
  } else {
    return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }

  const { error } = await db.from("deal_profiles").update(patch).eq("deal_id", dealId);
  if (error) return NextResponse.json({ error: "db error" }, { status: 500 });

  if (op === "note") {
    const result = await extractProfile(db, dealId, { manual: true });
    return NextResponse.json({ ok: true, corrections: corr, reran: result.ran, profile: result.profile ?? null, reason: result.reason });
  }
  return NextResponse.json({ ok: true, corrections: corr });
}
