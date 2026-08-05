"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VmPanel, type VmDrop } from "./VmPanel";

/**
 * Per-rep personal settings. The chosen voicemail drop is remembered on this
 * machine and used by the dialer's "Drop VM" button.
 */
export function ProfileView({ isAdmin }: { isAdmin: boolean }) {
  const [vmDrop, setVmDrop] = useState<VmDrop | null>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem("vmDrop");
      if (s) setVmDrop(JSON.parse(s));
    } catch {}
  }, []);

  const select = (d: VmDrop | null) => {
    setVmDrop(d);
    try {
      if (d) localStorage.setItem("vmDrop", JSON.stringify(d));
      else localStorage.removeItem("vmDrop");
    } catch {}
  };

  return (
    <>
      <h2 className="viewtitle">My profile</h2>
      <div className="viewsub" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        Personal settings — saved on this machine.
        {isAdmin && (
          <Link href="/settings" className="btn ghost" style={{ padding: "4px 12px", fontSize: 13 }}>
            ⚙ Team config →
          </Link>
        )}
      </div>
      <div style={{ maxWidth: 440 }}>
        <VmPanel selected={vmDrop} onSelect={select} />
      </div>
    </>
  );
}
