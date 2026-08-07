"use client";

import { useEffect, useState } from "react";

/** Light/dark toggle. Persists to localStorage; the <head> script applies the
 *  saved theme before paint so there's no flash on load. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = (document.documentElement.dataset.theme as "dark" | "light") || "dark";
    setTheme(saved);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  }

  return (
    <button className="theme-toggle" onClick={toggle} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
      {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
    </button>
  );
}
