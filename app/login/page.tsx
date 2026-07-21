"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    router.push("/scoreboard");
    router.refresh();
  };

  return (
    <main style={{ maxWidth: 380, margin: "0 auto", padding: "12vh 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--accent)",
            display: "grid",
            placeItems: "center",
            fontSize: 16,
            color: "#fff",
          }}
        >
          ▲
        </div>
        <div>
          <h1 style={{ fontSize: 17, letterSpacing: "0.06em" }}>LPO SALES ENGINE</h1>
          <small style={{ color: "var(--text-3)" }}>Sign in</small>
        </div>
      </div>
      <form onSubmit={signIn} className="card" style={{ display: "grid", gap: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div style={{ color: "var(--crit)", fontSize: 13 }}>{error}</div>}
        <button className="btn primary" style={{ justifyContent: "center" }} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
