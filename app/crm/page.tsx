import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { CrmView } from "../components/CrmView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "CRM · LPO Sales Engine" };

export default async function CrmPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const isAdmin = user.role === "admin";
  return (
    <AppShell active="/crm" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CrmView
        isAdmin={isAdmin}
        defaultOwner={!isAdmin && user.pipedriveUserId ? String(user.pipedriveUserId) : ""}
      />
    </AppShell>
  );
}
