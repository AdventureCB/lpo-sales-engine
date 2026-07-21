"use client";

import { useEffect } from "react";

/**
 * Reload control for the desktop companion (a Tauri window has no browser
 * chrome). Also binds Cmd/Ctrl+R. Harmless in the browser, where both
 * already exist.
 */
export function RefreshButton() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        window.location.reload();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <button
      className="btn ghost"
      style={{ padding: "5px 10px", fontSize: 13 }}
      onClick={() => window.location.reload()}
      title="Refresh (⌘R)"
    >
      ⟳
    </button>
  );
}
