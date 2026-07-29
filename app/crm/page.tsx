import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { CrmView } from "../components/CrmView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "CRM · LPO Sales Engine" };

export default async function CrmPage() {
  const user = await getSessionUser();
  if (user?.role !== "admin") redirect("/scoreboard");
  return (
    <AppShell active="/crm" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CrmView />
    </AppShell>
  );
}
