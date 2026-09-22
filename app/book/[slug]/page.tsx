import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { bookableReps } from "@/lib/booking";
import { BookingView } from "../../components/BookingView";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const rep = (await bookableReps(supabaseAdmin())).find((r) => r.slug === slug.toLowerCase());
  return { title: rep ? `Schedule with ${rep.first} · Lone Peak Overland` : "Schedule with a Gravel Guide" };
}

/** Public per-rep booking page: /book/<slug>. */
export default async function BookRepPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const rep = (await bookableReps(supabaseAdmin())).find((r) => r.slug === slug.toLowerCase());
  if (!rep) notFound();
  return <BookingView repSlug={rep.slug} repFirst={rep.first} />;
}
