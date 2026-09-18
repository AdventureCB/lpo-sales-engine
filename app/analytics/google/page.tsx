import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CampaignAnalyticsView } from "../../components/CampaignAnalyticsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Google Ads · LPO Sales Engine" };

export default async function GoogleAnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/google" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CampaignAnalyticsView channel="google" title="🔍 Google Ads" />
    </AppShell>
  );
}
