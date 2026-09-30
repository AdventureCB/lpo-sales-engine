import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { RevenueView } from "../../components/RevenueView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Revenue · LPO Sales Engine" };

export default async function RevenuePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/revenue" user={{ name: user.repName ?? user.email, role: user.role }}>
      <RevenueView />
    </AppShell>
  );
}
