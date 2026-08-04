import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { CallLogView } from "../components/CallLogView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Call Log · LPO Sales Engine" };

export default async function CallLogPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/call-log" user={{ name: user.repName ?? user.email, role: user.role }}>
      <CallLogView />
    </AppShell>
  );
}
