import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CampaignAnalyticsView } from "../../components/CampaignAnalyticsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Meta Ads · LPO Sales Engine" };

export default async function MetaAnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/meta" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CampaignAnalyticsView channel="meta" title="📘 Meta Ads" />
    </AppShell>
  );
}
