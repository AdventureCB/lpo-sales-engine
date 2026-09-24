import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unlinked opt-out endpoint (never shown in campaign emails — Kyle 9/24).
 * Token = the campaign_sends id; marks the contact opted out of email and
 * ends any active campaign. Kept so an opt-out can always be honored.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = supabaseAdmin();
  if (/^[0-9a-f-]{36}$/.test(token)) {
    const { data: s } = await db.from("campaign_sends").select("contact_id, deal_id").eq("id", token).maybeSingle();
    if (s?.contact_id) {
      await db.from("crm_contacts").update({ email_unsub: true, email_unsub_at: new Date().toISOString(), email_unsub_source: "link" }).eq("id", s.contact_id);
      const { data: enrs } = await db.from("campaign_enrollments").select("id").eq("contact_id", s.contact_id).eq("status", "active");
      for (const e of enrs ?? []) {
        await db.from("campaign_enrollments").update({ status: "exited", exited_at: new Date().toISOString(), exit_reason: "opted out (link)" }).eq("id", e.id);
        await db.from("campaign_sends").update({ status: "skipped", error: "opted out" }).eq("enrollment_id", e.id).in("status", ["draft", "approved"]);
      }
    }
  }
  return new NextResponse("<html><body style=\"font-family:sans-serif;padding:40px\">You won't receive further follow-ups from us. Thanks for letting us know.</body></html>", {
    headers: { "Content-Type": "text/html" },
  });
}
