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

// The model occasionally returns a list field as one string despite the
// schema (crashed the dialer once: cached script with plan-as-string →
// .map is not a function). Coerce, never trust.
const asLines = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : v == null || v === "" ? [] : String(v).split(/\n+/).map((s) => s.trim()).filter(Boolean);
const asObjections = (v: unknown): { objection: string; counter: string }[] =>
  Array.isArray(v)
    ? v.filter((o) => o && typeof o === "object").map((o) => ({ objection: String((o as any).objection ?? ""), counter: String((o as any).counter ?? "") }))
    : [];

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

  // Inline emphasis from the model's markers: **bold** = load-bearing words,
  // *italic* = what the customer might say. Plain text renders unchanged.
  const em = (raw: string | null | undefined): React.ReactNode[] => {
    const text = String(raw ?? "");
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) parts.push(<b key={i++} style={{ color: "var(--text-1)" }}>{tok.slice(2, -2)}</b>);
      else parts.push(<i key={i++} style={{ color: "var(--accent-2, var(--text-2))" }}>{tok.slice(1, -1)}</i>);
      last = m.index + tok.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };

  const Section = ({ label, first, children }: { label: string; first?: boolean; children: React.ReactNode }) => (
    <div style={{ borderTop: first ? "none" : "1px solid var(--border-soft)", paddingTop: first ? 0 : 10, marginTop: first ? 0 : 2 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text-2)" }}>{children}</div>
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
            <div style={{ display: "grid", gap: 8 }}>
              <Section label="🪝 Hook" first>{em(call.hook)}</Section>
              <Section label="🧭 Their story">{em(call.their_story)}</Section>
              <Section label="🤝 Guide move">{em(call.guide_move)}</Section>
              <Section label="🗺 The plan">
                <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 3 }}>
                  {asLines(call.plan).map((p, i) => <li key={i}>{em(p)}</li>)}
                </ol>
              </Section>
              {asLines(call.discovery).length > 0 && (
                <Section label="❓ Ask">
                  <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
                    {asLines(call.discovery).map((q, i) => <li key={i}>{em(q)}</li>)}
                  </ul>
                </Section>
              )}
              {asObjections(call.objections).length > 0 && (
                <Section label="🛡 If they push back">
                  <div style={{ display: "grid", gap: 5 }}>
                    {asObjections(call.objections).map((o, i) => (
                      <div key={i}>
                        <i style={{ color: "var(--accent-2, var(--text-2))" }}>“{String(o.objection ?? "").replace(/\*/g, "")}”</i>
                        <span style={{ color: "var(--text-3)" }}> → </span>
                        {em(o.counter)}
                      </div>
                    ))}
                  </div>
                </Section>
              )}
              <Section label="🎯 The ask">{em(call.cta)}</Section>
              <Section label="📼 If voicemail">{em(call.voicemail)}</Section>
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
