import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { TextsView } from "../components/TextsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Text · LPO Sales Engine" };

export default async function TextsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/texts" user={{ name: user.repName ?? user.email, role: user.role }}>
      <TextsView isAdmin={user.role === "admin"} />
    </AppShell>
  );
}
