"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ChatWindow } from "./ChatWindow";
import { bumpUnread, closeChat, getChats, subscribeChats, toggleMinimize, type ChatSession } from "./chatDockStore";

/**
 * Messenger-style dock: open conversations float bottom-right; minimized ones
 * collapse to tabs. Mounted in AppShell so it rides along on every page;
 * sessions persist across navigation via sessionStorage. ⧉ pops a chat into
 * its own browser window (dual-screen) and removes it from the dock.
 */
export function ChatDock() {
  const router = useRouter();
  const pathname = usePathname();
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [baseline, setBaseline] = useState<Record<string, number>>({}); // incoming count at minimize time

  useEffect(() => {
    setChats([...getChats()]);
    return subscribeChats(() => setChats([...getChats()]));
  }, []);

  // The popout page renders its own ChatWindow — no dock on top of it.
  if (pathname?.startsWith("/texts/chat")) return null;
  if (chats.length === 0) return null;

  const popout = (c: ChatSession) => {
    const params = new URLSearchParams({ phone: c.phone });
    if (c.name) params.set("name", c.name);
    if (c.dealId) params.set("dealId", c.dealId);
    const url = `/texts/chat?${params}`;
    // Only drop the docked copy once a window actually opened — popup blockers
    // (and the desktop companion's webview) return null, and closing the dock
    // chat then would make the conversation vanish entirely.
    let w = window.open(url, `chat-${c.phone.replace(/\D/g, "")}`, "width=430,height=680,resizable=yes,popup=yes");
    if (!w) w = window.open(url, "_blank"); // fallback: plain new tab
    if (w) closeChat(c.phone);
  };

  const minimize = (c: ChatSession, incomingNow: number) => {
    setBaseline((b) => ({ ...b, [c.phone]: incomingNow }));
    toggleMinimize(c.phone);
  };

  const open = chats.filter((c) => !c.minimized);
  const minimized = chats.filter((c) => c.minimized);

  return (
    <div style={{ position: "fixed", bottom: 0, right: 16, zIndex: 850, display: "flex", alignItems: "flex-end", gap: 10, pointerEvents: "none" }}>
      {/* Minimized tabs */}
      {minimized.map((c) => (
        <div key={c.phone} style={{ pointerEvents: "auto" }}>
          {/* Keep polling while minimized so the tab can badge unread. */}
          <ChatWindow
            phone={c.phone}
            name={c.name}
            dealId={c.dealId}
            hidden
            onNewIncoming={(n) => bumpUnread(c.phone, Math.max(0, n - (baseline[c.phone] ?? n)))}
          />
          <button
            className="btn"
            style={{ borderRadius: "10px 10px 0 0", padding: "7px 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 6, boxShadow: "0 -2px 12px rgba(0,0,0,0.25)" }}
            onClick={() => toggleMinimize(c.phone)}
            title={c.phone}
          >
            💬 {c.name ?? c.phone}
            {c.unread > 0 && (
              <span style={{ background: "var(--accent)", color: "#fff", borderRadius: 999, fontSize: 10.5, fontWeight: 700, padding: "2px 6px", lineHeight: 1 }}>
                {c.unread}
              </span>
            )}
            <span
              style={{ color: "var(--text-3)", marginLeft: 2 }}
              onClick={(e) => {
                e.stopPropagation();
                closeChat(c.phone);
              }}
            >
              ✕
            </span>
          </button>
        </div>
      ))}

      {/* Open windows */}
      {open.map((c) => (
        <ChatDockWindow key={c.phone} chat={c} onMinimize={minimize} onPopout={popout} onOpenDeal={(id) => router.push(`/crm/deal/${id}`)} />
      ))}
    </div>
  );
}

function ChatDockWindow({
  chat,
  onMinimize,
  onPopout,
  onOpenDeal,
}: {
  chat: ChatSession;
  onMinimize: (c: ChatSession, incomingNow: number) => void;
  onPopout: (c: ChatSession) => void;
  onOpenDeal: (dealId: string) => void;
}) {
  const [incoming, setIncoming] = useState(0);
  const btn: React.CSSProperties = { border: "none", background: "none", cursor: "pointer", color: "var(--text-3)", fontSize: 13, padding: "2px 4px", lineHeight: 1 };
  return (
    <div
      className="card"
      style={{
        pointerEvents: "auto",
        width: 320,
        height: 430,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: "12px 12px 0 0",
        boxShadow: "0 -4px 24px rgba(0,0,0,0.35)",
      }}
    >
      <ChatWindow
        phone={chat.phone}
        name={chat.name}
        dealId={chat.dealId}
        onNewIncoming={setIncoming}
        header={
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--border-soft)", background: "var(--surface-2)" }}>
            <b style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={chat.phone}>
              {chat.name ?? chat.phone}
            </b>
            {chat.dealId && (
              <button style={btn} title="Open deal in CRM" onClick={() => onOpenDeal(chat.dealId!)}>📋</button>
            )}
            <button style={btn} title="Pop out to its own window" onClick={() => onPopout(chat)}>⧉</button>
            <button style={btn} title="Minimize" onClick={() => onMinimize(chat, incoming)}>—</button>
            <button style={btn} title="Close" onClick={() => closeChat(chat.phone)}>✕</button>
          </div>
        }
      />
    </div>
  );
}
