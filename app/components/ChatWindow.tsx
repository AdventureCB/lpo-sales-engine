"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fillPlaceholders } from "@/lib/placeholders";

interface Msg {
  id: string;
  direction: "incoming" | "outgoing" | null;
  status: string | null;
  body: string | null;
  at: string;
  rep: string | null;
  ourNumber: string | null;
}

interface Macro {
  id: string;
  name: string;
  channel: string;
  body: string;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * One text conversation — Messenger-style. Used three ways:
 *   dock window (bottom of any page), the standalone popout (/texts/chat,
 *   dual-screen), and hidden-while-minimized (keeps polling for unread).
 */
export function ChatWindow({
  phone,
  name,
  dealId,
  standalone,
  hidden,
  onNewIncoming,
  header,
}: {
  phone: string;
  name?: string | null;
  dealId?: string | null;
  standalone?: boolean;
  hidden?: boolean; // minimized in the dock: mounted (polling) but not shown
  onNewIncoming?: (incomingCount: number) => void;
  header?: React.ReactNode; // dock injects its minimize/popout/close buttons
}) {
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [compose, setCompose] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    () =>
      fetch(`/api/texts/thread?phone=${encodeURIComponent(phone)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setMessages(d.messages))
        .catch(() => {}),
    [phone]
  );

  useEffect(() => {
    setMessages(null);
    void load();
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }, 8_000);
    return () => clearInterval(iv);
  }, [load]);

  // Surface inbound count so a minimized tab can badge unread.
  const incomingCount = (messages ?? []).filter((m) => m.direction === "incoming").length;
  useEffect(() => {
    if (messages !== null) onNewIncoming?.(incomingCount);
  }, [incomingCount, messages, onNewIncoming]);

  // Texting macros (channel sms/any) — compact picker.
  useEffect(() => {
    fetch("/api/crm/comm-library")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMacros(((d.myMacros ?? []) as Macro[]).filter((m) => m.channel === "sms" || m.channel === "any")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, hidden]);

  const send = async () => {
    const body = compose.trim();
    if (!body || sending) return;
    setSending(true);
    setErr(null);
    try {
      const r = await fetch("/api/texts/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phone, body, crmDealId: dealId ?? undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setCompose("");
      setMessages((prev) => [...(prev ?? []), d.message]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const applyMacro = (id: string) => {
    const m = macros.find((x) => x.id === id);
    if (!m) return;
    setCompose(fillPlaceholders(m.body, { name: name ?? null }));
  };

  if (hidden) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        ...(standalone
          ? { position: "fixed", inset: 0, background: "var(--surface-1)" }
          : { height: "100%" }),
      }}
    >
      {header}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 7 }}>
        {messages === null && <div style={{ fontSize: 13, color: "var(--text-3)" }}>Loading…</div>}
        {messages !== null && messages.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--text-3)" }}>No messages yet — say hello 👋</div>
        )}
        {(messages ?? []).map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.direction === "outgoing" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              background: m.direction === "outgoing" ? "var(--accent-soft)" : "var(--surface-2)",
              border: "1px solid var(--border-soft)",
              borderRadius: 11,
              padding: "6px 10px",
            }}
          >
            <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body ?? "(no text)"}</div>
            <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 2, textAlign: m.direction === "outgoing" ? "right" : "left" }}>
              {m.direction === "outgoing" && m.rep ? `${m.rep} · ` : ""}
              {fmtWhen(m.at)}
              {m.direction === "outgoing" && m.status === "failed" && <span style={{ color: "var(--crit)" }}> · failed</span>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 8, borderTop: "1px solid var(--border-soft)" }}>
        {err && <div style={{ color: "var(--crit)", fontSize: 12.5, marginBottom: 5 }}>{err}</div>}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          {macros.length > 0 && (
            <select
              className="vmsel"
              style={{ width: 34, padding: "8px 4px", fontSize: 13, flexShrink: 0 }}
              value=""
              title="Insert a text macro"
              onChange={(e) => e.target.value && applyMacro(e.target.value)}
            >
              <option value="">📋</option>
              {macros.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
          <textarea
            className="vmsel"
            style={{ flex: 1, resize: "none", minHeight: 36, maxHeight: 110, fontFamily: "inherit", fontSize: 13.5 }}
            rows={Math.min(4, Math.max(1, compose.split("\n").length))}
            placeholder="Type a message…"
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn primary" style={{ padding: "8px 13px", fontSize: 13.5 }} disabled={!compose.trim() || sending} onClick={send}>
            {sending ? "…" : "➤"}
          </button>
        </div>
      </div>
    </div>
  );
}
