import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { AIProfilerAdmin } from "../../components/SettingsView";
import { AiAccuracy } from "../../components/AiAccuracy";
import { CallPatterns } from "../../components/CallPatterns";
import { HypothesesView } from "../../components/HypothesesView";
import { getSessionUser } from "@/lib/auth";

export const metadata = { title: "AI Profiler · Settings · LPO Sales Engine" };

export default async function ProfilerSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/settings/profile");
  return (
    <AppShell active="/settings/profiler" user={{ name: user.repName ?? user.email, role: user.role }}>
      <h2 className="viewtitle">AI Profiler</h2>
      <AIProfilerAdmin />
      <HypothesesView />
      <AiAccuracy />
      <CallPatterns />
      <Link href="/settings/archetypes" className="card" style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: 680, marginTop: 18, textDecoration: "none", color: "inherit" }}>
        <span style={{ fontSize: 22 }}>🧠</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Archetype Mapping</div>
          <div className="viewsub" style={{ margin: 0 }}>Personas + universal attributes the AI deal-profiler classifies against.</div>
        </div>
        <span style={{ color: "var(--text-3)" }}>→</span>
      </Link>
    </AppShell>
  );
}
