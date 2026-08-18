"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fillPlaceholders } from "@/lib/placeholders";

interface Msg {
  id: string;
  direction: "incoming" | "outgoing" | null;
  status: string | null;
  body: string | null;
  media?: string[] | null;
  at: string;
  rep: string | null;
  ourNumber: string | null;
}

const EMOJI = [
  "👍", "🙏", "🎉", "😀", "😂", "😅", "🤝", "👋", "💪", "🔥",
  "❤️", "⭐", "✅", "📞", "📅", "🚙", "🏔", "🏕", "⛺", "🌲",
  "🛻", "🗺", "☀️", "❄️", "🌊", "🐕", "👀", "🤔", "😎", "🫡",
];

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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attached, setAttached] = useState<{ url: string; preview: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [optedOutPrompt, setOptedOutPrompt] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  // Viewing the conversation marks it read (clears the Texts-page dot) —
  // on load, on each new inbound while visible, and when un-minimized.
  const loaded = messages !== null;
  useEffect(() => {
    if (hidden || !loaded) return;
    fetch("/api/texts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    }).catch(() => {});
  }, [hidden, loaded, incomingCount, phone]);

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

  const send = async (opts?: { force?: boolean; optInRequest?: boolean }) => {
    const body = compose.trim();
    if ((!body && attached.length === 0 && !opts?.optInRequest) || sending) return;
    setSending(true);
    setErr(null);
    try {
      const r = await fetch("/api/texts/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: phone,
          body: opts?.optInRequest ? "" : body,
          crmDealId: dealId ?? undefined,
          mediaUrls: opts?.optInRequest ? undefined : attached.map((a) => a.url),
          force: opts?.force || undefined,
          optInRequest: opts?.optInRequest || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409 && d.optedOut) {
        // This contact texted STOP — the rep chooses: opt-in request, force, cancel.
        setOptedOutPrompt(true);
        return;
      }
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setOptedOutPrompt(false);
      if (!opts?.optInRequest) {
        setCompose("");
        setAttached([]);
      }
      setMessages((prev) => [...(prev ?? []), d.message]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const attachImage = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setUploading(true);
    setErr(null);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
        fr.onerror = () => reject(new Error("read failed"));
        fr.readAsDataURL(file);
      });
      const r = await fetch("/api/texts/upload-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: file.type, dataBase64 }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setAttached((prev) => [...prev, { url: d.url, preview: URL.createObjectURL(file) }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
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
            {(m.media ?? []).map((u, i) => (
              <a key={i} href={u} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="attachment" style={{ maxWidth: "100%", borderRadius: 8, marginBottom: m.body ? 4 : 0, display: "block" }} />
              </a>
            ))}
            {(m.body || !(m.media ?? []).length) && (
              <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body ?? "(no text)"}</div>
            )}
            <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 2, textAlign: m.direction === "outgoing" ? "right" : "left" }}>
              {m.direction === "outgoing" && m.rep ? `${m.rep} · ` : ""}
              {fmtWhen(m.at)}
              {m.direction === "outgoing" && m.status === "failed" && <span style={{ color: "var(--crit)" }}> · failed</span>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 8, borderTop: "1px solid var(--border-soft)", position: "relative" }}>
        {optedOutPrompt && (
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ fontSize: 12.5, color: "var(--crit)", fontWeight: 700, marginBottom: 6 }}>
              🛑 This contact opted out of texts
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button className="btn" style={{ fontSize: 12.5, justifyContent: "flex-start" }} disabled={sending} onClick={() => void send({ optInRequest: true })} title="Sends the standard opt-in invitation — your message stays in the box for after they opt back in">
                📨 Send opt-in request
              </button>
              <button className="btn" style={{ fontSize: 12.5, justifyContent: "flex-start" }} disabled={sending} onClick={() => void send({ force: true })} title="Send anyway — for an active existing conversation">
                ⚠️ Force send (existing conversation)
              </button>
              <button className="btn ghost" style={{ fontSize: 12.5, justifyContent: "flex-start" }} onClick={() => setOptedOutPrompt(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {err && <div style={{ color: "var(--crit)", fontSize: 12.5, marginBottom: 5 }}>{err}</div>}
        {attached.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attached.map((a, i) => (
              <span key={i} style={{ position: "relative", display: "inline-block" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.preview} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border-soft)" }} />
                <button
                  onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
                  style={{ position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: "50%", border: "none", background: "var(--crit)", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer" }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {emojiOpen && (
          <div style={{ position: "absolute", bottom: "100%", left: 8, right: 8, background: "var(--surface-1)", border: "1px solid var(--border-soft)", borderRadius: 10, padding: 8, display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 2, boxShadow: "0 -4px 18px rgba(0,0,0,0.3)", zIndex: 5 }}>
            {EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => { setCompose((c) => c + e); setEmojiOpen(false); }}
                style={{ border: "none", background: "none", fontSize: 17, cursor: "pointer", padding: 2, borderRadius: 6 }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
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
          <button
            className="btn ghost"
            style={{ padding: "7px 7px", fontSize: 14, flexShrink: 0 }}
            title="Emoji"
            onClick={() => setEmojiOpen((v) => !v)}
          >
            😀
          </button>
          <button
            className="btn ghost"
            style={{ padding: "7px 7px", fontSize: 14, flexShrink: 0 }}
            title="Attach a photo (MMS)"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "…" : "🖼"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void attachImage(f);
              e.target.value = "";
            }}
          />
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
          <button
            className="btn primary"
            style={{ padding: "8px 13px", fontSize: 13.5 }}
            disabled={(!compose.trim() && attached.length === 0) || sending || uploading}
            onClick={() => void send()}
          >
            {sending ? "…" : "➤"}
          </button>
        </div>
      </div>
    </div>
  );
}
