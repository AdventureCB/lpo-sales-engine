"use client";

import { useEffect, useRef, useState } from "react";
import { openChat } from "./chatDockStore";

interface CallScript {
  hook: string;
  their_story: string;
  guide_move: string;
  plan: string[];
  discovery: string[];
  objections?: { objection: string; counter: string }[];
  cta: string;
  voicemail: string;
}

/**
 * 🗒 Scripts & drafts — collapsed by default. The call outline (StoryBrand)
 * preloads during the dialer review pause; email/text drafts generate ONLY on
 * their buttons and one-click fill the composer / chat dock.
 */
export function ScriptsCard({
  dealId,
  phone,
  contactName,
  hasEmail,
  defaultOpen = false,
}: {
  dealId: string;
  phone: string | null;
  contactName: string | null;
  hasEmail: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [call, setCall] = useState<CallScript | null>(null);
  const [email, setEmail] = useState<{ subject: string; body: string } | null>(null);
  const [sms, setSms] = useState<{ body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "call" | "email" | "sms"
  const [err, setErr] = useState<string | null>(null);
  const fetchedFor = useRef<string | null>(null);

  const gen = async (kind: "call" | "email" | "sms", force = false) => {
    setBusy(kind);
    setErr(null);
    try {
      const r = await fetch("/api/ai/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId, kind, force }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      if (kind === "call") setCall(d.script);
      else if (kind === "email") setEmail(d.script);
      else setSms(d.script);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // The dialer preload already generated (and cached) the call script — this
  // fetch is a cache hit. On the plain deal page it generates on first expand.
  useEffect(() => {
    if (!open || fetchedFor.current === dealId) return;
    fetchedFor.current = dealId;
    void gen("call");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dealId]);

  // New deal → reset local state.
  useEffect(() => {
    setCall(null);
    setEmail(null);
    setSms(null);
    setErr(null);
    fetchedFor.current = null;
  }, [dealId]);

  const useEmail = () => {
    if (!email) return;
    window.dispatchEvent(new CustomEvent("lpo:compose", { detail: { dealId, channel: "email", subject: email.subject, body: email.body } }));
  };
  const useSms = () => {
    if (!sms || !phone) return;
    openChat({ phone, name: contactName, dealId, draft: sms.body });
  };

  const line = (label: string, text: string) => (
    <div style={{ display: "flex", gap: 8, fontSize: 13.5, lineHeight: 1.45 }}>
      <b style={{ flexShrink: 0, width: 74, color: "var(--text-3)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em", paddingTop: 2 }}>{label}</b>
      <span style={{ color: "var(--text-1)" }}>{text}</span>
    </div>
  );

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
        title={open ? "Collapse" : "Expand"}
      >
        <div className="panel-h" style={{ margin: 0, flex: 1 }}>🗒 Scripts &amp; drafts</div>
        <span style={{ color: "var(--text-3)", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
          {err && <div style={{ color: "var(--crit)", fontSize: 13 }}>{err}</div>}

          {/* Call outline (StoryBrand) */}
          {busy === "call" && !call && <div style={{ color: "var(--text-3)", fontSize: 13 }}>Building call outline…</div>}
          {call && (
            <div style={{ display: "grid", gap: 6 }}>
              {line("Hook", call.hook)}
              {line("Their story", call.their_story)}
              {line("Guide", call.guide_move)}
              {line("Plan", (call.plan ?? []).join("  →  "))}
              {(call.discovery ?? []).length > 0 && line("Ask", (call.discovery ?? []).join(" · "))}
              {(call.objections ?? []).map((o, i) => line(i === 0 ? "Objections" : "", `"${o.objection}" → ${o.counter}`))}
              {line("CTA", call.cta)}
              {line("Voicemail", call.voicemail)}
              <div>
                <button className="btn ghost" style={{ padding: "2px 10px", fontSize: 12 }} disabled={busy === "call"} onClick={() => void gen("call", true)}>
                  ↻ Rebuild outline
                </button>
              </div>
            </div>
          )}

          {/* Drafts — generated individually, on purpose */}
          <div style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn" style={{ padding: "6px 12px", fontSize: 13 }} disabled={!hasEmail || busy === "email"} title={hasEmail ? "Draft an email for this buyer" : "No email on contact"} onClick={() => void gen("email", !!email)}>
                {busy === "email" ? "Drafting…" : email ? "↻ Redraft email" : "✉️ Draft email"}
              </button>
              <button className="btn" style={{ padding: "6px 12px", fontSize: 13 }} disabled={!phone || busy === "sms"} title={phone ? "Draft a text for this buyer" : "No phone on contact"} onClick={() => void gen("sms", !!sms)}>
                {busy === "sms" ? "Drafting…" : sms ? "↻ Redraft text" : "💬 Draft text"}
              </button>
            </div>

            {email && (
              <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "10px 12px", fontSize: 13.5 }}>
                <b>{email.subject}</b>
                <div style={{ whiteSpace: "pre-wrap", marginTop: 6, color: "var(--text-2)" }}>{email.body}</div>
                <button className="btn primary" style={{ padding: "5px 14px", fontSize: 13, marginTop: 8 }} onClick={useEmail}>
                  Use in email composer →
                </button>
              </div>
            )}
            {sms && (
              <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "10px 12px", fontSize: 13.5 }}>
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text-2)" }}>{sms.body}</div>
                <button className="btn primary" style={{ padding: "5px 14px", fontSize: 13, marginTop: 8 }} disabled={!phone} onClick={useSms}>
                  Use in text chat →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
