import { AppShell } from "../components/AppShell";
import { HotListView } from "../components/HotListView";

export const metadata = { title: "Hot List · LPO Sales Engine" };

export default function HotListPage() {
  return (
    <AppShell active="/hot-list">
      <HotListView />
    </AppShell>
  );
}
