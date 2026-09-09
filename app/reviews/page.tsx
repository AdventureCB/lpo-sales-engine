import { redirect } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ReviewsView } from "../components/ReviewsView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Call Reviews · LPO Sales Engine" };

export default async function ReviewsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <AppShell active="/reviews" user={{ name: user.repName ?? user.email, role: user.role }}>
      <ReviewsView isAdmin={user.role === "admin"} />
    </AppShell>
  );
}
