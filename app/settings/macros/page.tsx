import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { MacroLibraryView } from "../../components/MacroLibraryView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Macro Library · LPO Sales Engine" };

export default async function MacrosPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/settings" user={{ name: user.repName ?? user.email, role: user.role }}>
      <MacroLibraryView isAdmin={user.role === "admin"} />
    </AppShell>
  );
}
