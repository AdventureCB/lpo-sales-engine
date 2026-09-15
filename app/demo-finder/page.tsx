import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { DemoFinderView } from "../components/DemoFinderView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Demo Finder · LPO Sales Engine" };

export default async function DemoFinderPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/demo-finder" user={{ name: user.repName ?? user.email, role: user.role }}>
      <DemoFinderView />
    </AppShell>
  );
}
