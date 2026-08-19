import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { PhoneGoalsAdmin, VoicemailAdmin } from "../../components/SettingsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Phone & Goals · Settings · LPO Sales Engine" };

export default async function PhoneSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/phone" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">Phone &amp; Goals</h2>
      <PhoneGoalsAdmin />
      <VoicemailAdmin />
    </AppShell>
  );
}
