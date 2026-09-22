import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { BOOKING_KINDS, bookingBase, DEFAULT_CONFIG, DEFAULT_CONFIRMATIONS, KIND_META, loadBookingConfig, repBookingUrl, teamTemplates, TEMPLATE_VARS, type BookingConfig, type ConfirmationMap } from "@/lib/booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: booking availability config + per-rep links/slugs + recent bookings. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const db = supabaseAdmin();
  const [cfg, { data: reps }, { data: recent }] = await Promise.all([
    loadBookingConfig(db),
    db.from("reps").select("id, name, email, booking_slug, booking_enabled, booking_hours, telnyx_number, sort_order").eq("active", true).not("email", "is", null).order("sort_order").order("name"),
    db
      .from("bookings")
      .select("id, kind, customer_name, customer_email, customer_phone, start_at, via, status, deal_id, created_at, reps ( name )")
      .order("created_at", { ascending: false })
      .limit(25),
  ]);
  const { confirmation: _legacy, ...rest } = cfg;
  return NextResponse.json({
    config: { ...rest, confirmations: teamTemplates(cfg) },
    defaults: { ...DEFAULT_CONFIG, confirmations: DEFAULT_CONFIRMATIONS },
    kinds: BOOKING_KINDS.map((k) => ({ id: k, label: KIND_META[k].label, emoji: KIND_META[k].emoji })),
    vars: TEMPLATE_VARS,
    base: bookingBase(),
    reps: (reps ?? []).map((r: any) => ({
      id: r.id, name: r.name, email: r.email, slug: r.booking_slug ?? "", enabled: !!r.booking_enabled, hasPhone: !!r.telnyx_number,
      url: r.booking_slug ? repBookingUrl(r.booking_slug) : null,
      custom: !!r.booking_hours,
    })),
    recent: (recent ?? []).map((b: any) => ({
      id: b.id, kind: b.kind ?? "call", name: b.customer_name, email: b.customer_email, phone: b.customer_phone, startAt: b.start_at, via: b.via, status: b.status,
      dealId: b.deal_id, createdAt: b.created_at, rep: b.reps?.name ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: { config?: Partial<BookingConfig>; reps?: { id: string; slug: string; enabled: boolean }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();

  if (body.config) {
    const c = body.config;
    const hhmm = (s: unknown) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
    const next: BookingConfig = {
      slot_minutes: Math.min(120, Math.max(15, Math.round(Number(c.slot_minutes ?? DEFAULT_CONFIG.slot_minutes)))),
      days: Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : DEFAULT_CONFIG.days,
      start: hhmm(c.start) ? (c.start as string) : DEFAULT_CONFIG.start,
      end: hhmm(c.end) ? (c.end as string) : DEFAULT_CONFIG.end,
      min_notice_hours: Math.min(72, Math.max(0, Number(c.min_notice_hours ?? DEFAULT_CONFIG.min_notice_hours))),
      horizon_days: Math.min(90, Math.max(1, Math.round(Number(c.horizon_days ?? DEFAULT_CONFIG.horizon_days)))),
    };
    if (next.start >= next.end) return NextResponse.json({ error: "Start time must be before end time." }, { status: 400 });
    if (next.days.length === 0) return NextResponse.json({ error: "Pick at least one day." }, { status: 400 });
    // Team-default confirmation templates, one per booking type (guides may
    // override with their own). A type left blank falls back to the built-in.
    const src = (c.confirmations && typeof c.confirmations === "object" ? c.confirmations : {}) as ConfirmationMap;
    const map: ConfirmationMap = {};
    for (const k of BOOKING_KINDS) {
      const t = src[k];
      if (!t || typeof t !== "object") continue;
      const subject = String(t.subject ?? "").trim().slice(0, 200);
      const tbody = String(t.body ?? "").trim().slice(0, 4000);
      if (subject && tbody) map[k] = { subject, body: tbody };
    }
    if (Object.keys(map).length) next.confirmations = map;
    await db.from("crm_sync_state").upsert({ key: "booking_config", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  }

  if (body.reps) {
    const seen = new Set<string>();
    for (const r of body.reps) {
      const slug = String(r.slug ?? "").trim().toLowerCase();
      if (slug && !/^[a-z0-9-]{2,30}$/.test(slug)) return NextResponse.json({ error: `Slug "${slug}" — use 2–30 letters, numbers or dashes.` }, { status: 400 });
      if (slug && seen.has(slug)) return NextResponse.json({ error: `Slug "${slug}" is used twice.` }, { status: 400 });
      if (slug) seen.add(slug);
      if (r.enabled && !slug) return NextResponse.json({ error: "An enabled guide needs a slug." }, { status: 400 });
    }
    for (const r of body.reps) {
      const slug = String(r.slug ?? "").trim().toLowerCase() || null;
      const { error } = await db.from("reps").update({ booking_slug: slug, booking_enabled: !!r.enabled && !!slug }).eq("id", r.id);
      if (error) return NextResponse.json({ error: error.code === "23505" ? `Slug "${slug}" is already taken.` : "db error" }, { status: 400 });
    }
  }
  return NextResponse.json({ ok: true });
}
