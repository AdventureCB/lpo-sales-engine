import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ArchetypeMappingView } from "../../components/ArchetypeMappingView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Archetype Mapping · LPO Sales Engine" };

export default async function ArchetypesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings");
  return (
    <AppShell active="/settings" user={{ name: user.repName ?? user.email, role: user.role }}>
      <ArchetypeMappingView />
    </AppShell>
  );
}
