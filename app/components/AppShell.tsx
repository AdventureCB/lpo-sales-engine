import Link from "next/link";
import { UserChip } from "./UserChip";
import { RefreshButton } from "./RefreshButton";
import { NavGroup } from "./NavGroup";

interface NavItem {
  label: string;
  href: string;
  adminOnly?: boolean;
}

const SECTIONS: { header: string | null; collapsible?: boolean; items: NavItem[] }[] = [
  {
    header: "Phone",
    collapsible: true,
    items: [
      { label: "📞 Dialer", href: "/dialer" },
      { label: "🕘 Call log", href: "/call-log" },
      { label: "💬 Text", href: "/texts" },
      { label: "🟢 WhatsApp", href: "/whatsapp" },
    ],
  },
  {
    header: "Sales",
    items: [
      { label: "🔥 Hot List", href: "/hot-list" },
      { label: "Scoreboard", href: "/scoreboard" },
      { label: "Lookup", href: "/lookup" },
    ],
  },
  {
    header: "Admin",
    items: [
      { label: "Quality", href: "/quality", adminOnly: true },
      { label: "CRM", href: "/crm", adminOnly: true },
      { label: "Commissions", href: "/commissions", adminOnly: true },
      { label: "⚙ Settings", href: "/settings", adminOnly: true },
    ],
  },
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
  const isAdmin = user?.role === "admin";
  return (
    <div className="shell">
      <aside className="sidenav">
        <div className="logo">
          <div className="mark">▲</div>
          <div>
            LPO SALES ENGINE<small>Lone Peak Overland</small>
          </div>
        </div>
        <nav>
          {SECTIONS.map((section) => {
            const items = section.items.filter((t) => !t.adminOnly || isAdmin);
            if (items.length === 0) return null;
            if (section.collapsible && section.header) {
              return <NavGroup key={section.header} header={section.header} items={items} active={active} />;
            }
            return (
              <div className="navsec" key={section.header ?? "main"}>
                {section.header && <h5>{section.header}</h5>}
                {items.map((t) => (
                  <Link key={t.href} href={t.href} className={active === t.href ? "active" : ""}>
                    {t.label}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidefoot">
          {user ? (
            <UserChip name={user.name} role={user.role} />
          ) : (
            <div className="userchip">
              <span>Team view</span>
            </div>
          )}
          <RefreshButton />
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}
