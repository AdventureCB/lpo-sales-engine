"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";

export function UserChip({ name, role }: { name: string; role: string }) {
  const router = useRouter();
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
      <div className="avatar" style={{ background: "var(--accent)" }}>{initials}</div>
      <button
        className="btn ghost"
        style={{ padding: "5px 10px", fontSize: 12 }}
        onClick={signOut}
        title="Sign out"
      >
        Sign out
      </button>
    </div>
  );
}
