import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { StandaloneChat } from "./StandaloneChat";

export const metadata = { title: "Text · LPO Sales Engine" };

/**
 * Popped-out conversation window (⧉ from the chat dock) — a bare chat that
 * can live on a second screen while the CRM fills the first.
 */
export default async function ChatPopoutPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string; name?: string; dealId?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { phone, name, dealId } = await searchParams;
  if (!phone) redirect("/texts");
  return <StandaloneChat phone={phone} name={name ?? null} dealId={dealId ?? null} />;
}
