import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { BookingSettings } from "../../components/BookingSettings";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Booking · Settings · LPO Sales Engine" };

export default async function BookingSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/booking" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">📅 Booking — Schedule with a Gravel Guide</h2>
      <BookingSettings />
    </AppShell>
  );
}
