"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { VmPanel, type VmDrop } from "./VmPanel";
import { RingtonePicker } from "./RingtonePicker";
import { VersionStamp } from "./VersionStamp";
import RichTextEditor from "./RichTextEditor";

/**
 * Per-rep personal settings. The chosen voicemail drop is remembered on this
 * machine and used by the dialer's "Drop VM" button.
 */
export function ProfileView({ isAdmin }: { isAdmin: boolean }) {
  const [vmDrop, setVmDrop] = useState<VmDrop | null>(null);
  const [sig, setSig] = useState("");
  const [sigMsg, setSigMsg] = useState<string | null>(null);
  const [sigSaving, setSigSaving] = useState(false);

  useEffect(() => {
    try {
      const s = localStorage.getItem("vmDrop");
      if (s) setVmDrop(JSON.parse(s));
    } catch {}
    fetch("/api/me/signature")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSig(d.signature ?? ""))
      .catch(() => {});
  }, []);

  const saveSig = async () => {
    setSigSaving(true);
    const r = await fetch("/api/me/signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: sig }),
    }).catch(() => null);
    setSigSaving(false);
    setSigMsg(r?.ok ? "✓ Saved" : "⚠ Failed");
    setTimeout(() => setSigMsg(null), 2000);
  };

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
        <VersionStamp />
        {isAdmin && (
          <Link href="/settings" className="btn ghost" style={{ padding: "4px 12px", fontSize: 13 }}>
            ⚙ Team config →
          </Link>
        )}
      </div>
      <Link href="/settings/macros" className="card" style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: 560, marginBottom: 18, textDecoration: "none", color: "inherit" }}>
        <span style={{ fontSize: 22 }}>✍️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Macro Library</div>
          <div className="viewsub" style={{ margin: 0 }}>Your message macros + shared templates and assets to add.</div>
        </div>
        <span style={{ color: "var(--text-3)" }}>→</span>
      </Link>

      <div style={{ maxWidth: 440 }}>
        <VmPanel selected={vmDrop} onSelect={select} />
      </div>

      <div className="card" style={{ maxWidth: 560, marginTop: 18 }}>
        <div className="panel-h">📳 Ringtone</div>
        <RingtonePicker />
      </div>

      <div className="card" style={{ maxWidth: 560, marginTop: 18 }}>
        <div className="panel-h">✍️ Email signature</div>
        <div style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 8 }}>
          Appended to every email you send — formatting, links, and images carry through.
        </div>
        <RichTextEditor value={sig} onChange={setSig} placeholder={"—\nJane Rep\nLone Peak Overland"} minHeight={110} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button className="btn primary" onClick={saveSig} disabled={sigSaving}>{sigSaving ? "Saving…" : "Save signature"}</button>
          {sigMsg && <span style={{ fontSize: 13, color: sigMsg.startsWith("✓") ? "var(--good)" : "var(--bad)" }}>{sigMsg}</span>}
        </div>
      </div>
    </>
  );
}
