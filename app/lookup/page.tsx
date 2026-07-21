import { AppShell } from "../components/AppShell";
import { LookupView } from "../components/LookupView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Lookup · LPO Sales Engine" };

export default async function LookupPage() {
  const user = await getSessionUser();
  return (
    <AppShell
      active="/lookup"
      user={user ? { name: user.repName ?? user.email, role: user.role } : null}
    >
      <LookupView />
    </AppShell>
  );
}
