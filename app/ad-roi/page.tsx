import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { AdRoiView } from "../components/AdRoiView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Ad ROI · LPO Sales Engine" };

export default async function AdRoiPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dialer");
  return (
    <AppShell active="/ad-roi" user={{ name: user.repName ?? user.email, role: user.role }}>
      <AdRoiView />
    </AppShell>
  );
}
