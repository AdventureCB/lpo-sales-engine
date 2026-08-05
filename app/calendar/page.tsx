import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { CalendarView } from "../components/CalendarView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Calendar · LPO Sales Engine" };

export default async function CalendarPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/calendar" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CalendarView isAdmin={user.role === "admin"} />
    </AppShell>
  );
}
