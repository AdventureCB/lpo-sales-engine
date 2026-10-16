import { redirect } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { RepDashboardView } from "../../../components/RepDashboardView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Rep dashboard · LPO Sales Engine" };

export default async function RepDashboardPage({ params }: { params: Promise<{ rep: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  const { rep } = await params;
  return (
    <AppShell active="/analytics/reps" user={{ name: user.repName ?? user.email, role: user.role }}>
      <RepDashboardView rep={decodeURIComponent(rep)} backHref="/analytics/reps" />
    </AppShell>
  );
}
