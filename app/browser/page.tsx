"use client";

import { useState } from "react";

/**
 * Start page for the 🧰 "Web browser" tool window. Native tool windows have
 * no address bar, so this page IS the address bar: queries → Google, things
 * that look like URLs → straight there (same window — tracking label keeps
 * counting). Reopening the Browser tile always lands back here.
 */
export default function BrowserStart() {
  const [q, setQ] = useState("");

  const go = () => {
    const v = q.trim();
    if (!v) return;
    const isUrl = /^[a-z]+:\/\//i.test(v) || (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(v) && !v.includes(" "));
    window.location.href = isUrl
      ? (/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`)
      : `https://www.google.com/search?q=${encodeURIComponent(v)}`;
  };

  const quick = [
    ["Google", "https://www.google.com"],
    ["Maps", "https://maps.google.com"],
    ["Lone Peak site", "https://lonepeakoverland.com"],
  ] as const;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, background: "var(--surface-1, #0f1115)", color: "var(--text-1, #e7e9ec)", padding: 24 }}>
      <div style={{ fontSize: 42 }}>🌐</div>
      <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 560 }}>
        <input
          autoFocus
          className="vmsel"
          style={{ flex: 1, fontSize: 16, padding: "12px 16px", borderRadius: 12 }}
          placeholder="Search Google or type a URL…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <button className="btn primary" style={{ padding: "12px 22px", fontSize: 15, borderRadius: 12 }} onClick={go}>
          Go
        </button>
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 13.5 }}>
        {quick.map(([label, url]) => (
          <a key={url} href={url} style={{ color: "var(--text-2, #b9bec6)" }}>{label}</a>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-3, #9aa0a6)" }}>
        Tip: to search again later, close this window and click the Browser tile — it always starts here.
      </div>
    </div>
  );
}
