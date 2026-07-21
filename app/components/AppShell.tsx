import Link from "next/link";

const TABS = [
  { label: "Dialer", href: "/dialer", live: false },
  { label: "🔥 Hot List", href: "/hot-list", live: true },
  { label: "Scoreboard", href: "/scoreboard", live: true },
  { label: "Commissions", href: "/commissions", live: false },
];

export function AppShell({ active, children }: { active: string; children: React.ReactNode }) {
  return (
    <>
      <header className="app">
        <div className="logo">
          <div className="mark">▲</div>
          <div>
            LPO SALES ENGINE<small>Lone Peak Overland</small>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((t) =>
            t.live ? (
              <Link key={t.label} href={t.href} className={active === t.href ? "active" : ""}>
                {t.label}
              </Link>
            ) : (
              <a key={t.label} className="soon">
                {t.label}
                <small>SOON</small>
              </a>
            )
          )}
        </nav>
        <div className="userchip">
          <span>Team view</span>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}
