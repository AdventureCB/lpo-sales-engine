"use client";

import { useEffect, useState } from "react";
import { openChat } from "./chatDockStore";

interface Thread {
  phone: string;
  lastAt: string;
  lastBody: string | null;
  lastDirection: string | null;
  awaitingReply: boolean;
  unread: boolean;
  count: number;
  contactName: string | null;
  crmDealId: string | null;
  dealTitle: string | null;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Thread list — conversations open Messenger-style in the chat dock (bottom
 * of the page), minimize to tabs, and pop out to their own window (⧉) for a
 * second screen. Reps see only their own line's conversations.
 */
export function TextsView({ isAdmin }: { isAdmin: boolean }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [search, setSearch] = useState("");
  const [newNum, setNewNum] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const loadThreads = () =>
    fetch("/api/texts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setThreads(d.threads));

  useEffect(() => {
    void loadThreads();
    const iv = setInterval(loadThreads, 20_000);
    return () => clearInterval(iv);
  }, []);

  const openThread = (t: Thread) => {
    openChat({ phone: t.phone, name: t.contactName, dealId: t.crmDealId });
    // Optimistic: the ChatWindow marks it read server-side within a second;
    // clear the dot immediately so it doesn't linger until the next poll.
    setThreads((prev) => prev?.map((x) => (x.phone === t.phone ? { ...x, unread: false } : x)) ?? prev);
  };

  const startNew = () => {
    const digits = newNum.replace(/[^\d]/g, "").replace(/^1/, "");
    if (digits.length !== 10) return;
    setShowNew(false);
    setNewNum("");
    openChat({ phone: `+1${digits}` });
  };

  const runBackfill = async () => {
    setBackfilling(true);
    try {
      const r = await fetch("/api/texts/backfill", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      alert(r.ok ? `Imported: ${JSON.stringify(d.stored)}` : `Import failed: ${d.error}`);
      void loadThreads();
    } finally {
      setBackfilling(false);
    }
  };

  const q = search.trim().toLowerCase();
  const shownThreads = (threads ?? []).filter(
    (t) =>
      !q ||
      t.phone.includes(q) ||
      (t.contactName ?? "").toLowerCase().includes(q) ||
      (t.lastBody ?? "").toLowerCase().includes(q)
  );

  return (
    <>
      <h2 className="viewtitle">Text</h2>
      <div className="viewsub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        Click a conversation to open it at the bottom of the page — minimize it to a tab, or pop it out (⧉) to its own window.
        {isAdmin && (
          <button className="btn ghost" style={{ padding: "3px 10px", fontSize: 13 }} onClick={runBackfill} disabled={backfilling}>
            {backfilling ? "Importing…" : "⤓ Import Quo history"}
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, maxWidth: 620, display: "flex", flexDirection: "column", overflow: "hidden", height: "calc(100vh - 200px)", minHeight: 420 }}>
        <div style={{ padding: 10, display: "flex", gap: 6, borderBottom: "1px solid var(--border-soft)" }}>
          <input
            className="vmsel"
            style={{ flex: 1 }}
            placeholder="Search name, number, text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn" style={{ padding: "6px 12px" }} title="New text" onClick={() => setShowNew((v) => !v)}>
            ＋
          </button>
        </div>
        {showNew && (
          <div style={{ padding: 10, display: "flex", gap: 6, borderBottom: "1px solid var(--border-soft)" }}>
            <input
              className="vmsel"
              style={{ flex: 1 }}
              placeholder="Phone number…"
              value={newNum}
              autoFocus
              onChange={(e) => setNewNum(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startNew()}
            />
            <button
              className="btn primary"
              style={{ padding: "6px 12px", fontSize: 14 }}
              disabled={newNum.replace(/[^\d]/g, "").replace(/^1/, "").length !== 10}
              onClick={startNew}
            >
              Start
            </button>
          </div>
        )}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {threads === null && <div className="viewsub" style={{ padding: 12 }}>Loading…</div>}
          {threads !== null && shownThreads.length === 0 && (
            <div className="viewsub" style={{ padding: 12, marginBottom: 0 }}>
              No conversations on your line yet — new inbound texts appear here automatically.
            </div>
          )}
          {shownThreads.map((t) => (
            <div
              key={t.phone}
              onClick={() => openThread(t)}
              style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-soft)", cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <b style={{ fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.unread && <span style={{ color: "var(--accent)" }}>● </span>}
                  {t.contactName ?? t.phone}
                </b>
                <span style={{ color: "var(--text-3)", fontSize: 12.5, whiteSpace: "nowrap" }}>{fmtWhen(t.lastAt)}</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <div style={{ color: "var(--text-3)", fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, flex: 1 }}>
                  {t.lastDirection === "outgoing" && "→ "}
                  {t.lastBody ?? "(no text)"}
                </div>
                {t.dealTitle && (
                  <span style={{ color: "var(--text-3)", fontSize: 12, whiteSpace: "nowrap" }}>📋 {t.dealTitle.slice(0, 26)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
