const modules = [
  { name: "Dialer — Queue Runner", phase: "Phase 3", status: "planned" },
  { name: "🔥 Hot List", phase: "Phase 2", status: "planned" },
  { name: "Scoreboard", phase: "Phase 1", status: "planned" },
  { name: "Commissions", phase: "Phase 4", status: "planned" },
];

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--accent)",
            display: "grid",
            placeItems: "center",
            fontSize: 16,
          }}
        >
          ⛰️
        </div>
        <div>
          <h1 style={{ fontSize: 18, letterSpacing: "0.06em" }}>LPO SALES ENGINE</h1>
          <small style={{ color: "var(--text-3)" }}>Phase 0 — cloud worker skeleton</small>
        </div>
      </div>

      <ul style={{ listStyle: "none", marginTop: 32, display: "grid", gap: 10 }}>
        {modules.map((m) => (
          <li
            key={m.name}
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius)",
              padding: "14px 18px",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>{m.name}</span>
            <span style={{ color: "var(--text-3)" }}>
              {m.phase} · {m.status}
            </span>
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 32, color: "var(--text-2)", fontSize: 13, lineHeight: 1.6 }}>
        Live now: <code>/api/webhooks/shopify</code> (orders/paid + orders/refunded, HMAC-verified)
        · <code>/api/webhooks/quo</code> (call lifecycle) · <code>/api/health</code> · cron stubs
        for the hot-list sweep and nightly call reconciliation.
      </p>
    </main>
  );
}
