"use client";

import { useEffect, useState } from "react";
import { openChat } from "./chatDockStore";
import { useRoster } from "./useRoster";

interface Thread {
  phone: string;
  lastAt: string;
  lastBody: string | null;
  lastDirection: string | null;
  awaitingReply: boolean;
  unread: boolean;
  done: boolean;
  doneAt: string | null;
  favorite: boolean;
  lastInboundAt: string | null;
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
  type Tab = "todo" | "fav" | "done" | "all";
  const [tab, setTab] = useState<Tab>(() => { try { return (sessionStorage.getItem("textsTab") as Tab) || "todo"; } catch { return "todo"; } });
  const [oldestFirst, setOldestFirst] = useState(false);
  const pickTab = (t: Tab) => { setTab(t); try { sessionStorage.setItem("textsTab", t); } catch {} };

  const setDone = async (t: Thread, done: boolean) => {
    setThreads((prev) => prev?.map((x) => (x.phone === t.phone ? { ...x, done, doneAt: done ? new Date().toISOString() : null, unread: done ? false : x.unread } : x)) ?? prev);
    await fetch("/api/texts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: t.phone, done, lastAt: t.lastAt }) });
  };
  const setFavorite = async (t: Thread, favorite: boolean) => {
    setThreads((prev) => prev?.map((x) => (x.phone === t.phone ? { ...x, favorite } : x)) ?? prev);
    await fetch("/api/texts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: t.phone, favorite }) });
  };
  // Admin: narrow to one rep's lines (remembered per browser).
  const roster = useRoster();
  const [repSel, setRepSel] = useState<string>(() => { try { return sessionStorage.getItem("textsRep") ?? ""; } catch { return ""; } });
  const pickRep = (v: string) => { setRepSel(v); setThreads(null); try { sessionStorage.setItem("textsRep", v); } catch {} };

  const loadThreads = () =>
    fetch(`/api/texts${isAdmin && repSel ? `?rep=${encodeURIComponent(repSel)}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setThreads(d.threads));

  useEffect(() => {
    void loadThreads();
    const iv = setInterval(loadThreads, 20_000);
    return () => clearInterval(iv);
  }, [repSel]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const all = threads ?? [];
  const todoCount = all.filter((t) => !t.done).length;
  const favCount = all.filter((t) => t.favorite).length;
  // Inbox order: the most recently RECEIVED text first (reps 10/27) — a
  // thread the rep just replied on sorts by when the customer last wrote,
  // not by the rep's own send. Threads with no inbound yet use their last send.
  const recvAt = (t: Thread) => t.lastInboundAt ?? t.lastAt;
  const shownThreads = all
    .filter((t) => (tab === "todo" ? !t.done : tab === "done" ? t.done : tab === "fav" ? t.favorite : true))
    .filter(
      (t) =>
        !q ||
        t.phone.includes(q) ||
        (t.contactName ?? "").toLowerCase().includes(q) ||
        (t.lastBody ?? "").toLowerCase().includes(q)
    )
    .sort((a, b) => (oldestFirst ? recvAt(a).localeCompare(recvAt(b)) : recvAt(b).localeCompare(recvAt(a))));

  return (
    <>
      <h2 className="viewtitle">Text</h2>
      <div className="viewsub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        Click a conversation to open it at the bottom of the page — minimize it to a tab, or pop it out (⧉) to its own window.
        {isAdmin && (
          <select className="vmsel" style={{ width: "auto", padding: "3px 8px", fontSize: 13 }} value={repSel} onChange={(e) => pickRep(e.target.value)} title="Show one rep's conversations">
            <option value="">All reps</option>
            {roster.active.filter((r) => r.email).map((r) => <option key={r.id} value={r.email!}>{r.name}</option>)}
          </select>
        )}
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
        <div style={{ padding: "6px 10px", display: "flex", gap: 6, alignItems: "center", borderBottom: "1px solid var(--border-soft)" }}>
          {([["todo", `To do${todoCount ? ` · ${todoCount}` : ""}`], ["fav", `⭐${favCount ? ` ${favCount}` : ""}`], ["done", "Done"], ["all", "All"]] as const).map(([k, l]) => (
            <button key={k} className={`btn ${tab === k ? "primary" : "ghost"}`} style={{ padding: "3px 10px", fontSize: 12.5 }} title={k === "fav" ? "Favorites — conversations you starred" : undefined} onClick={() => pickTab(k)}>{l}</button>
          ))}
          <button className="btn ghost" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 12.5 }} title="Ordered by when the customer last texted — click to flip" onClick={() => setOldestFirst((v) => !v)}>
            {oldestFirst ? "Oldest received first ↑" : "Latest received first ↓"}
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
              {tab === "todo" ? "All caught up — nothing left to do." : tab === "done" ? "Nothing marked done yet." : tab === "fav" ? "No favorites yet — click the ☆ on a conversation to keep it here." : "No conversations on your line yet — new inbound texts appear here automatically."}
            </div>
          )}
          {shownThreads.map((t) => (
            <div
              key={t.phone}
              onClick={() => openThread(t)}
              style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-soft)", cursor: "pointer", display: "flex", gap: 10, alignItems: "flex-start", opacity: t.done && tab !== "done" ? 0.6 : 1 }}
            >
              <input
                type="checkbox"
                checked={t.done}
                title={t.done ? `Done ${t.doneAt ? fmtWhen(t.doneAt) : ""} — untick to bring it back` : "Mark this conversation done (a new text from them brings it back)"}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => void setDone(t, e.target.checked)}
                style={{ marginTop: 4, width: 16, height: 16, cursor: "pointer" }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <b style={{ fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: t.done ? "line-through" : undefined, color: t.done ? "var(--text-2)" : undefined }}>
                  {t.unread && <span style={{ color: "var(--accent)" }}>● </span>}
                  {t.contactName ?? t.phone}
                </b>
                <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--text-3)", fontSize: 12.5 }} title={t.lastInboundAt ? `Last received ${fmtWhen(t.lastInboundAt)}` : "No reply yet"}>{fmtWhen(t.lastAt)}</span>
                  <button
                    type="button"
                    title={t.favorite ? "Unfavorite" : "Favorite — keep this conversation in the ⭐ tab"}
                    onClick={(e) => { e.stopPropagation(); void setFavorite(t, !t.favorite); }}
                    style={{ border: 0, background: "none", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0, color: t.favorite ? "#f5b301" : "var(--text-3)" }}
                  >
                    {t.favorite ? "★" : "☆"}
                  </button>
                </span>
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
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
