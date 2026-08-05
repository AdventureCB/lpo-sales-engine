import { redirect } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { DealDetailView } from "../../../components/DealDetailView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Deal · LPO Sales Engine" };

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  return (
    <AppShell active="/crm" user={{ name: user.repName ?? user.email, role: user.role }}>
      <DealDetailView dealId={id} />
    </AppShell>
  );
}
