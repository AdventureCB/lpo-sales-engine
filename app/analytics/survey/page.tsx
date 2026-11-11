import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { SurveyAnalyticsView } from "../../components/SurveyAnalyticsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Build Survey · LPO Sales Engine" };

export default async function SurveyAnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/survey" user={{ name: user.repName ?? user.email, role: user.role }}>
      <SurveyAnalyticsView />
    </AppShell>
  );
}
