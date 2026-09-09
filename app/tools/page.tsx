import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ToolsView } from "../components/ToolsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Tools · LPO Sales Engine" };

export default async function ToolsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/tools" user={{ name: user.repName ?? user.email, role: user.role }}>
      <ToolsView />
    </AppShell>
  );
}
