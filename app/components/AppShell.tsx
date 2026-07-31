import Link from "next/link";
import { UserChip } from "./UserChip";
import { RefreshButton } from "./RefreshButton";

const TABS = [
  { label: "Dialer", href: "/dialer", live: true },
  { label: "🔥 Hot List", href: "/hot-list", live: true },
  { label: "Scoreboard", href: "/scoreboard", live: true },
  { label: "Lookup", href: "/lookup", live: true },
  { label: "WhatsApp", href: "/whatsapp", live: true },
  { label: "CRM", href: "/crm", live: true, adminOnly: true },
  { label: "Commissions", href: "/commissions", live: true, adminOnly: true },
];

export function AppShell({
  active,
  user,
  children,
}: {
  active: string;
  user?: { name: string; role: string } | null;
  children: React.ReactNode;
}) {
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
          {TABS.filter((t) => !("adminOnly" in t && t.adminOnly) || user?.role === "admin").map((t) =>
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
        {user ? (
          <UserChip name={user.name} role={user.role} />
        ) : (
          <div className="userchip">
            <span>Team view</span>
          </div>
        )}
        <RefreshButton />
      </header>
      <main>{children}</main>
    </>
  );
}
