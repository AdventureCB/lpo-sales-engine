"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Thread {
  phone: string;
  lastAt: string;
  lastBody: string | null;
  lastDirection: string | null;
  awaitingReply: boolean;
  count: number;
  contactName: string | null;
  crmDealId: string | null;
  dealTitle: string | null;
}

interface Msg {
  id: string;
  direction: "incoming" | "outgoing" | null;
  status: string | null;
  body: string | null;
  at: string;
  rep: string | null;
  ourNumber: string | null;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function TextsView({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [search, setSearch] = useState("");
  const [compose, setCompose] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [newNum, setNewNum] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = () =>
    fetch("/api/texts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setThreads(d.threads));

  const loadThread = (phone: string) =>
    fetch(`/api/texts/thread?phone=${encodeURIComponent(phone)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMessages(d.messages));

  useEffect(() => {
    void loadThreads();
    const iv = setInterval(loadThreads, 20_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!active) return;
    setMessages(null);
    void loadThread(active);
    const iv = setInterval(() => loadThread(active), 8_000);
    return () => clearInterval(iv);
  }, [active]);

  // Pin the thread to the bottom whenever messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, active]);

  const send = async () => {
    const body = compose.trim();
    if (!body || !active || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await fetch("/api/texts/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: active, body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setCompose("");
      setMessages((prev) => [...(prev ?? []), d.message]);
      void loadThreads();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const startNew = () => {
    const digits = newNum.replace(/[^\d]/g, "").replace(/^1/, "");
    if (digits.length !== 10) return;
    const e164 = `+1${digits}`;
    setShowNew(false);
    setNewNum("");
    setActive(e164);
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

  const activeThread = threads?.find((t) => t.phone === active) ?? null;
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
        Team text conversations — sends through Quo until the Telnyx cutover.
        {isAdmin && (
          <button className="btn ghost" style={{ padding: "3px 10px", fontSize: 13 }} onClick={runBackfill} disabled={backfilling}>
            {backfilling ? "Importing…" : "⤓ Import Quo history"}
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "310px 1fr", gap: 14, height: "calc(100vh - 200px)", minHeight: 420 }}>
        {/* thread list */}
        <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
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
                No conversations yet — new inbound texts appear here automatically.
              </div>
            )}
            {shownThreads.map((t) => (
              <div
                key={t.phone}
                onClick={() => setActive(t.phone)}
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border-soft)",
                  cursor: "pointer",
                  background: active === t.phone ? "var(--accent-soft)" : "transparent",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <b style={{ fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.awaitingReply && <span style={{ color: "var(--accent)" }}>● </span>}
                    {t.contactName ?? t.phone}
                  </b>
                  <span style={{ color: "var(--text-3)", fontSize: 12.5, whiteSpace: "nowrap" }}>{fmtWhen(t.lastAt)}</span>
                </div>
                <div style={{ color: "var(--text-3)", fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                  {t.lastDirection === "outgoing" && "→ "}
                  {t.lastBody ?? "(no text)"}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* conversation */}
        <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!active && (
            <div className="viewsub" style={{ padding: 20, marginBottom: 0 }}>
              Pick a conversation — or start one with ＋.
            </div>
          )}
          {active && (
            <>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 10 }}>
                <b style={{ fontSize: 14 }}>{activeThread?.contactName ?? active}</b>
                {activeThread?.contactName && (
                  <span style={{ color: "var(--text-3)", fontSize: 13.5 }}>{active}</span>
                )}
                {activeThread?.crmDealId && (
                  <button
                    className="btn ghost"
                    style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 13 }}
                    onClick={() => router.push(`/crm/deal/${activeThread.crmDealId}`)}
                  >
                    📋 {activeThread.dealTitle ?? "Open deal"}
                  </button>
                )}
              </div>
              <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                {messages === null && <div className="viewsub">Loading…</div>}
                {messages !== null && messages.length === 0 && (
                  <div className="viewsub">No messages yet — say hello 👋</div>
                )}
                {(messages ?? []).map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: m.direction === "outgoing" ? "flex-end" : "flex-start",
                      maxWidth: "72%",
                      background: m.direction === "outgoing" ? "var(--accent-soft)" : "var(--surface-2)",
                      border: "1px solid var(--border-soft)",
                      borderRadius: 12,
                      padding: "8px 12px",
                    }}
                  >
                    <div style={{ fontSize: 14.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body ?? "(no text)"}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 3, textAlign: m.direction === "outgoing" ? "right" : "left" }}>
                      {m.direction === "outgoing" && m.rep ? `${m.rep} · ` : ""}
                      {fmtWhen(m.at)}
                      {m.direction === "outgoing" && m.status === "failed" && (
                        <span style={{ color: "var(--crit)" }}> · failed</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)" }}>
                {sendError && (
                  <div style={{ color: "var(--crit)", fontSize: 13.5, marginBottom: 6 }}>{sendError}</div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <textarea
                    className="vmsel"
                    style={{ flex: 1, resize: "none", minHeight: 40, maxHeight: 120, fontFamily: "inherit" }}
                    rows={compose.split("\n").length > 3 ? 4 : Math.max(1, compose.split("\n").length)}
                    placeholder="Type a message… (Enter to send, Shift+Enter for a new line)"
                    value={compose}
                    onChange={(e) => setCompose(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <button className="btn primary" style={{ padding: "10px 18px" }} disabled={!compose.trim() || sending} onClick={send}>
                    {sending ? "…" : "Send"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
