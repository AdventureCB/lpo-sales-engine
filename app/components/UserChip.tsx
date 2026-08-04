"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function UserChip({ name, role }: { name: string; role: string }) {
  const router = useRouter();
  const [gmail, setGmail] = useState<{ configured: boolean; connected: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/gmail/status")
      .then((r) => (r.ok ? r.json() : null))
      .then(setGmail)
      .catch(() => {});
  }, []);
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const signOut = async () => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="userchip">
      <span>
        {name} · {role === "admin" ? "Admin" : "Rep"}
      </span>
      {gmail?.configured && !gmail.connected && (
        <a
          className="btn ghost"
          style={{ padding: "5px 10px", fontSize: 13, textDecoration: "none" }}
          href="/api/gmail/connect"
          title="Connect your Gmail — emails with contacts appear on their timelines"
        >
          ✉️ Connect Gmail
        </a>
      )}
      {gmail?.connected && (
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }} title="Gmail connected — mail syncs to contact timelines">
          ✉️ ✓
        </span>
      )}
      <div className="avatar" style={{ background: "var(--accent)" }}>{initials}</div>
      <button
        className="btn ghost"
        style={{ padding: "5px 10px", fontSize: 13 }}
        onClick={signOut}
        title="Sign out"
      >
        Sign out
      </button>
    </div>
  );
}
