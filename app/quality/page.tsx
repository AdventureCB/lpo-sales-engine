import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { QualityView } from "../components/QualityView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Call Quality · LPO Sales Engine" };

export default async function QualityPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/quality" user={{ name: user.repName ?? user.email, role: user.role }}>
      <QualityView />
    </AppShell>
  );
}
