import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { RepsAnalyticsView } from "../../components/RepsAnalyticsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Reps · LPO Sales Engine" };

export default async function RepsAnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/reps" user={{ name: user.repName ?? user.email, role: user.role }}>
      <RepsAnalyticsView />
    </AppShell>
  );
}
