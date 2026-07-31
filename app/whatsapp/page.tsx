import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { WhatsAppView } from "../components/WhatsAppView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "WhatsApp · LPO Sales Engine" };

export default async function WhatsAppPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/whatsapp" user={{ name: user.repName ?? user.email, role: user.role }}>
      <WhatsAppView isAdmin={user.role === "admin"} />
    </AppShell>
  );
}
