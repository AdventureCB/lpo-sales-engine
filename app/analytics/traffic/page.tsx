import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { TrafficAnalyticsView } from "../../components/TrafficAnalyticsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Website Traffic · LPO Sales Engine" };

export default async function TrafficAnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/traffic" user={{ name: user.repName ?? user.email, role: user.role }}>
      <TrafficAnalyticsView />
    </AppShell>
  );
}
