import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CampaignsView } from "../../components/CampaignsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Campaigns · LPO Sales Engine" };

export default async function CampaignsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/settings/campaigns" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CampaignsView />
    </AppShell>
  );
}
