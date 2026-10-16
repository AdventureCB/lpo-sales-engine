import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { RepDashboardView } from "../components/RepDashboardView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "My dashboard · LPO Sales Engine" };

/** A rep's own dashboard — same view admins see under Analytics → Reps. Not in the nav yet (Kyle decides when). */
export default async function MyDashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/my-dashboard" user={{ name: user.repName ?? user.email, role: user.role }}>
      <RepDashboardView rep={user.email} />
    </AppShell>
  );
}
