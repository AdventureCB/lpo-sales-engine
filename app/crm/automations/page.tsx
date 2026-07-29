import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { AutomationsView } from "../../components/AutomationsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Automations · LPO Sales Engine" };

export default async function AutomationsPage() {
  const user = await getSessionUser();
  if (user?.role !== "admin") redirect("/scoreboard");
  return (
    <AppShell active="/crm" user={{ name: user.repName ?? user.email, role: user.role }}>
      <AutomationsView />
    </AppShell>
  );
}
