import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ProfileView } from "../../components/ProfileView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "My Profile · LPO Sales Engine" };

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/settings" user={{ name: user.repName ?? user.email, role: user.role }}>
      <ProfileView isAdmin={user.role === "admin"} />
    </AppShell>
  );
}
