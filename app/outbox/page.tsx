import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { OutboxView } from "../components/OutboxView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Outbox · LPO Sales Engine" };

export default async function OutboxPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/outbox" user={{ name: user.repName ?? user.email, role: user.role }}>
      <OutboxView />
    </AppShell>
  );
}
