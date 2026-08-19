import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { PipelineAdmin, DealSourcesAdmin, SprintListConfigAdmin, ReassignAdmin } from "../../components/SettingsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "CRM · Settings · LPO Sales Engine" };

export default async function CrmSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/crm" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">CRM settings</h2>
      <PipelineAdmin />
      <DealSourcesAdmin />
      <SprintListConfigAdmin />
      <ReassignAdmin />
    </AppShell>
  );
}
