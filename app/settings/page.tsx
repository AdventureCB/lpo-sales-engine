import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "Settings · LPO Sales Engine" };

/** Settings is a menu now — land admins on CRM config, reps on their profile. */
export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  redirect(user.role === "admin" ? "/settings/crm" : "/settings/profile");
}
