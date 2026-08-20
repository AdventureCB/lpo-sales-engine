import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CommLibraryAdmin } from "../../components/SettingsView";
import { DraftThemesAdmin } from "../../components/DraftThemesAdmin";
import { DraftReview } from "../../components/DraftReview";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Comms · Settings · LPO Sales Engine" };

export default async function CommsSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/comms" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">Comms library</h2>
      <CommLibraryAdmin />
      <DraftThemesAdmin />
      <DraftReview />
    </AppShell>
  );
}
