import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { SettingsView } from "../components/SettingsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Settings · LPO Sales Engine" };

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings" user={{ name: user.repName ?? user.email, role: user.role }}>
      <SettingsView />
    </AppShell>
  );
}
