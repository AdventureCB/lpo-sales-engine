import { BookingView } from "../components/BookingView";

export const metadata = { title: "Schedule with a Gravel Guide · Lone Peak Overland" };
export const dynamic = "force-dynamic";

/** Public round-robin booking page — for customers who don't have a rep yet. */
export default function BookPage() {
  return <BookingView repSlug={null} repFirst={null} />;
}
