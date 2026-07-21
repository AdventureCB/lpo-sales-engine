import { AppShell } from "../components/AppShell";
import { ScoreboardView } from "../components/ScoreboardView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Scoreboard · LPO Sales Engine" };

export default async function ScoreboardPage() {
  const user = await getSessionUser();
  return (
    <AppShell
      active="/scoreboard"
      user={user ? { name: user.repName ?? user.email, role: user.role } : null}
    >
      <ScoreboardView />
    </AppShell>
  );
}
