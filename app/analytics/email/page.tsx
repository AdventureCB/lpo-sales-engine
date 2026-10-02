import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { EmailAnalyticsView } from "../../components/EmailAnalyticsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Email Marketing · LPO Sales Engine" };

export default async function EmailAnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/email" user={{ name: user.repName ?? user.email, role: user.role }}>
      <EmailAnalyticsView />
    </AppShell>
  );
}
