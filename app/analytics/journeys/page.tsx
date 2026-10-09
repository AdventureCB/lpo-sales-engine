import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { JourneysView } from "../../components/JourneysView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Journeys · LPO Sales Engine" };

export default async function JourneysPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/analytics/journeys" user={{ name: user.repName ?? user.email, role: user.role }}>
      <JourneysView />
    </AppShell>
  );
}
