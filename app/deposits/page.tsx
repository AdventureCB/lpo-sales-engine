import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { DepositsView } from "../components/DepositsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Open Deposits · LPO Sales Engine" };

export default async function DepositsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/deposits" user={{ name: user.repName ?? user.email, role: user.role }}>
      <DepositsView />
    </AppShell>
  );
}
