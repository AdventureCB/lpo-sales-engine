import { AppShell } from "../components/AppShell";
import { DialerView } from "../components/DialerView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Dialer · LPO Sales Engine" };

export default async function DialerPage() {
  const user = await getSessionUser();
  return (
    <AppShell
      active="/dialer"
      user={user ? { name: user.repName ?? user.email, role: user.role } : null}
    >
      <DialerView isAdmin={user?.role === "admin"} />
    </AppShell>
  );
}
