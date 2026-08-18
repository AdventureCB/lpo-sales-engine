"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TextNavBadge } from "./TextNavBadge";

export interface NavGroupItem {
  label: string;
  href: string;
}

/**
 * Collapsible sidebar section. Opens automatically when the active page is
 * inside it; otherwise remembers the user's last choice per machine.
 */
export function NavGroup({
  header,
  items,
  active,
}: {
  header: string;
  items: NavGroupItem[];
  active: string;
}) {
  const containsActive = items.some((i) => i.href === active);
  const [open, setOpen] = useState(containsActive);

  useEffect(() => {
    if (containsActive) return; // active page inside → stay open
    const saved = localStorage.getItem(`nav:${header}`);
    if (saved !== null) setOpen(saved === "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () =>
    setOpen((v) => {
      localStorage.setItem(`nav:${header}`, v ? "0" : "1");
      return !v;
    });

  return (
    <div className="navsec">
      <h5
        onClick={toggle}
        style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 5 }}
        title={open ? "Collapse" : "Expand"}
      >
        <span style={{ fontSize: 8, width: 10 }}>{open ? "▼" : "▶"}</span>
        <span style={{ color: !open && containsActive ? "var(--accent)" : undefined }}>{header}</span>
      </h5>
      {open &&
        items.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={active === t.href ? "active" : ""}
            style={t.href === "/texts" ? { display: "flex", alignItems: "center", gap: 6 } : undefined}
          >
            {t.label}
            {t.href === "/texts" && <TextNavBadge />}
          </Link>
        ))}
    </div>
  );
}
