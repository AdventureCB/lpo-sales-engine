import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { IntakeAdmin } from "../../components/SettingsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Intake · Settings · LPO Sales Engine" };

export default async function IntakeSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/intake" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">Intake engines</h2>
      <IntakeAdmin />
    </AppShell>
  );
}
