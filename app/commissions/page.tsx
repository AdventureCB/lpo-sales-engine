import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { CommissionsView } from "../components/CommissionsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Commissions · LPO Sales Engine" };

export default async function CommissionsPage() {
  const user = await getSessionUser();
  if (user?.role !== "admin") redirect("/scoreboard");
  return (
    <AppShell active="/commissions" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CommissionsView />
    </AppShell>
  );
}
