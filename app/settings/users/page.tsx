import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { UsersAdmin } from "../../components/UsersAdmin";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Users · Settings · LPO Sales Engine" };

export default async function UsersSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/users" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">Users</h2>
      <UsersAdmin />
    </AppShell>
  );
}
