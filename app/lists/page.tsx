import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { SprintListsView } from "../components/SprintListsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Sprint Lists · LPO Sales Engine" };

export default async function ListsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/lists" user={{ name: user.repName ?? user.email, role: user.role }}>
      <SprintListsView isAdmin={user.role === "admin"} userEmail={user.email} />
    </AppShell>
  );
}
