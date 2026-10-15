import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { EmailListView } from "../components/EmailListView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Email List · LPO Sales Engine" };

export default async function EmailListPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/email-list" user={{ name: user.repName ?? user.email, role: user.role }}>
      <EmailListView isAdmin={user.role === "admin"} userEmail={user.email} />
    </AppShell>
  );
}
