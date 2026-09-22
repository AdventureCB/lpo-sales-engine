import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { getBookingByToken } from "@/lib/booking";
import { ManageBookingView } from "../../../components/ManageBookingView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manage your call · Lone Peak Overland" };

/** Public, token-scoped: the customer's own booking — cancel or reschedule. */
export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const b = await getBookingByToken(supabaseAdmin(), token);
  if (!b) notFound();
  return (
    <ManageBookingView
      token={token}
      booking={{
        kind: b.kind,
        status: b.status,
        startAt: b.start_at,
        name: b.customer_name,
        tz: b.customer_tz,
        rep: b.rep ? { first: b.rep.first, slug: b.rep.slug } : null,
      }}
    />
  );
}
