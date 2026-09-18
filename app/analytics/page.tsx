import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { AnalyticsOverview } from "../components/AnalyticsOverview";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Analytics · LPO Sales Engine" };

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics" user={{ name: user.repName ?? user.email, role: user.role }}>
      <AnalyticsOverview />
    </AppShell>
  );
}
