"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * WhatsApp inbox (Klaviyo Conversations). Threads/messages read from our DB
 * (instant); an open thread live-refreshes via a throttled server pull.
 */

interface Thread {
  profileId: string;
  contactName: string | null;
  lastBody: string | null;
  lastDirection: string;
  lastAt: string | null;
}

interface Msg {
  klaviyo_message_id: string;
  direction: "inbound" | "outbound";
  body: string;
  sent_at: string | null;
}

function fmtWhen(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function WhatsAppView({ isAdmin }: { isAdmin: boolean }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    const r = await fetch("/api/crm/whatsapp").catch(() => null);
    if (!r?.ok) return;
    const d = await r.json();
    setConnected(d.connected);
    setThreads(d.threads ?? []);
  }, []);

  const loadMessages = useCallback(async (profileId: string) => {
    const r = await fetch(`/api/crm/whatsapp?profile=${encodeURIComponent(profileId)}`).catch(() => null);
    if (!r?.ok) return;
    const d = await r.json();
    setMessages(d.messages ?? []);
  }, []);

  // Threads poll (our DB — cheap).
  useEffect(() => {
    void loadThreads();
    const iv = setInterval(loadThreads, 10_000);
    return () => clearInterval(iv);
  }, [loadThreads]);

  // Open thread: fast local poll + throttled live pull from Klaviyo.
  useEffect(() => {
    if (!active) return;
    void loadMessages(active);
    const local = setInterval(() => void loadMessages(active), 5_000);
    const live = setInterval(() => {
      void fetch("/api/crm/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: active, refresh: true }),
      });
    }, 12_000);
    return () => {
      clearInterval(local);
      clearInterval(live);
    };
  }, [active, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    if (!active || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    const r = await fetch("/api/crm/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: active, message: draft.trim() }),
    }).catch(() => null);
    if (r?.ok) {
      setDraft("");
      await loadMessages(active);
    } else {
      const d = await r?.json().catch(() => null);
      setError(d?.error ?? "Send failed");
    }
    setSending(false);
  };

  if (connected === false) {
    return (
      <>
        <h2 className="viewtitle">WhatsApp</h2>
        <div className="viewsub">Two-way WhatsApp via the Klaviyo Conversations API.</div>
        <div className="card" style={{ maxWidth: 520 }}>
          <b style={{ fontSize: 14 }}>Not connected yet</b>
          <div style={{ fontSize: 14, color: "var(--text-2)", margin: "8px 0 12px" }}>
            {isAdmin
              ? "Connect the Klaviyo account once for the whole team."
              : "An admin needs to connect the Klaviyo account."}
          </div>
          {isAdmin && (
            <a className="btn primary" style={{ textDecoration: "none", padding: "9px 16px", fontSize: 14.5 }} href="/api/klaviyo/connect">
              Connect Klaviyo
            </a>
          )}
        </div>
      </>
    );
  }

  const activeThread = threads.find((t) => t.profileId === active);

  return (
    <>
      <h2 className="viewtitle">WhatsApp</h2>
      <div className="viewsub">
        Inbound messages appear within ~a minute · open threads refresh live · replies allowed once a customer has messaged
      </div>
      <div className="split" style={{ alignItems: "stretch" }}>
        <div className="card" style={{ maxWidth: 320, minWidth: 260 }}>
          <div className="panel-h">Conversations</div>
          {threads.length === 0 && (
            <div style={{ fontSize: 14, color: "var(--text-3)" }}>
              No WhatsApp conversations yet — they appear when a customer messages.
            </div>
          )}
          {threads.map((t) => (
            <div
              key={t.profileId}
              onClick={() => setActive(t.profileId)}
              style={{
                padding: "9px 10px",
                borderRadius: 8,
                cursor: "pointer",
                background: active === t.profileId ? "var(--surface-2)" : "transparent",
                marginBottom: 2,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.contactName ?? "Unknown contact"}
                </b>
                <span style={{ fontSize: 11.5, color: "var(--text-3)", flexShrink: 0 }}>{fmtWhen(t.lastAt)}</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.lastDirection === "inbound" ? "" : "You: "}
                {t.lastBody}
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 420 }}>
          {!active ? (
            <div style={{ margin: "auto", color: "var(--text-3)", fontSize: 14 }}>Pick a conversation</div>
          ) : (
            <>
              <div className="panel-h">{activeThread?.contactName ?? "Conversation"}</div>
              <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
                {messages.map((m) => (
                  <div
                    key={m.klaviyo_message_id}
                    style={{
                      alignSelf: m.direction === "outbound" ? "flex-end" : "flex-start",
                      background: m.direction === "outbound" ? "var(--accent)" : "var(--surface-2)",
                      color: m.direction === "outbound" ? "#fff" : "var(--text-1)",
                      borderRadius: 12,
                      padding: "7px 11px",
                      maxWidth: "75%",
                      fontSize: 14.5,
                    }}
                  >
                    {m.body}
                    <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{fmtWhen(m.sent_at)}</div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              {error && <div style={{ fontSize: 13, color: "var(--crit)", marginBottom: 6 }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input
                  className="vmsel"
                  style={{ flex: 1 }}
                  placeholder="Reply on WhatsApp… (max 1024 chars)"
                  value={draft}
                  maxLength={1024}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void send();
                  }}
                />
                <button className="btn primary" style={{ padding: "8px 16px", fontSize: 14 }} onClick={send} disabled={sending || !draft.trim()}>
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
