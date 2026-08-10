import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { EngagementView } from "../components/EngagementView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Engagement · LPO Sales Engine" };

export default async function EngagementPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer"); // admin-only readout
  return (
    <AppShell active="/engagement" user={{ name: user.repName ?? user.email, role: user.role }}>
      <EngagementView />
    </AppShell>
  );
}
