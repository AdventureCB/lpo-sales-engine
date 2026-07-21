import { AppShell } from "../components/AppShell";
import { ScoreboardView } from "../components/ScoreboardView";

export const metadata = { title: "Scoreboard · LPO Sales Engine" };

export default function ScoreboardPage() {
  return (
    <AppShell active="/scoreboard">
      <ScoreboardView />
    </AppShell>
  );
}
