"use client";

import { useState } from "react";

interface FoundPhone {
  source: string;
  raw: string;
  e164: string | null;
}

interface LookupResult {
  profile: {
    email: string | null;
    name: string | null;
    created: string | null;
    location: Record<string, unknown>;
    phones: FoundPhone[];
  } | null;
  events?: { metric: string; datetime: string; detail: Record<string, unknown> }[];
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function LookupView() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const search = async () => {
    const term = email.trim();
    if (!term.includes("@")) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch(`/api/klaviyo/profile?email=${encodeURIComponent(term)}`);
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setResult(await r.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  const loc = result?.profile?.location ?? {};
  const locStr = [loc["city"], loc["region"]].filter(Boolean).join(", ");

  return (
    <>
      <h2 className="viewtitle">Profile lookup</h2>
      <div className="viewsub">
        Find a Klaviyo profile by email — phone numbers (wherever they hide) and recent activity
      </div>

      <div style={{ display: "flex", gap: 8, maxWidth: 520, marginBottom: 22 }}>
        <input
          className="vmsel"
          style={{ flex: 1, fontSize: 14, padding: "10px 13px" }}
          placeholder="customer@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          autoFocus
        />
        <button className="btn primary" onClick={search} disabled={loading}>
          {loading ? "Searching…" : "🔍 Search"}
        </button>
      </div>

      {error && <div className="viewsub" style={{ color: "var(--crit)" }}>{error}</div>}
      {result && !result.profile && (
        <div className="card" style={{ maxWidth: 520, color: "var(--text-2)" }}>
          No Klaviyo profile found for that email.
        </div>
      )}

      {result?.profile && (
        <div className="split" style={{ marginTop: 0 }}>
          <div className="card">
            <div className="panel-h">Profile</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>
              {result.profile.name ?? result.profile.email}
            </div>
            <div style={{ color: "var(--text-2)", fontSize: 13.5, marginTop: 3 }}>
              {result.profile.email}
              {locStr && <> · {locStr}</>}
            </div>

            <div className="panel-h" style={{ marginTop: 18 }}>Phone numbers</div>
            {result.profile.phones.length === 0 && (
              <div style={{ color: "var(--text-3)", fontSize: 13 }}>
                No phone anywhere on this profile.
              </div>
            )}
            {result.profile.phones.map((p, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "9px 0",
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {p.e164 ?? p.raw}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>{p.source}</div>
                </div>
                <button
                  className="btn ghost"
                  style={{ padding: "5px 11px", fontSize: 12 }}
                  onClick={() => copy(p.e164 ?? p.raw)}
                >
                  {copied === (p.e164 ?? p.raw) ? "✓ Copied" : "Copy"}
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="panel-h">Recent activity</div>
            {(result.events ?? []).length === 0 && (
              <div style={{ color: "var(--text-3)", fontSize: 13 }}>No events.</div>
            )}
            {(result.events ?? []).map((e, i) => (
              <div className="stmt-row" style={{ alignItems: "flex-start" }} key={i}>
                <div>
                  <b style={{ fontSize: 13 }}>{e.metric}</b>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {Object.entries(e.detail)
                      .map(([k, v]) => (k === "Subject" ? `“${v}”` : `${k.replace(/^\$/, "")}: ${v}`))
                      .join(" · ")}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0, marginLeft: 10 }}>
                  {fmtWhen(e.datetime)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
