"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Item {
  id: string; enrollmentId: string; campaignId: string; campaign: string; mode: string; step: number;
  dealId: string; dealTitle: string | null; stage: string | null; truck: string | null; contactName: string | null;
  owner: string; channel: string; to: string; subject: string | null; body: string; generatedBy: string; aiMeta: any;
  status: string; scheduledFor: string | null; approvedBy: string | null; approvedAt: string | null; edited: boolean; sentAt: string | null; error: string | null; createdAt: string;
  enrollment: { current_step: number; hold_reason: string | null; status: string } | null;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

/**
 * 📬 Outbox — every campaign send waits here for a human. Approve (at its
 * scheduled slot or now), edit first, skip the step, reject, or stop the
 * whole campaign for that deal. Reps see their own; admins can scope.
 */
export function OutboxView() {
  const [data, setData] = useState<{ isAdmin: boolean; me: string; scope: string; reps: { email: string; name: string }[]; items: Item[] } | null>(null);
  const [scope, setScope] = useState("mine");
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { subject: string; body: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/campaigns/outbox?scope=${encodeURIComponent(scope)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  const act = async (item: Item, action: string, extra: Record<string, unknown> = {}) => {
    setBusy(item.id);
    const d = drafts[item.id];
    const r = await fetch("/api/campaigns/outbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, action, ...(action === "approve" && d ? { subject: d.subject, body: d.body } : {}), ...extra }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok || j.error) { setMsg(`⚠ ${j.error ?? `HTTP ${r.status}`}`); return; }
    setMsg(action === "approve" ? (extra.sendNow ? "Sent ✓" : `Approved — sends ${fmt(j.scheduledFor ?? item.scheduledFor)} ✓`) : action === "skip" ? "Step skipped" : action === "reject" ? "Rejected" : "Campaign stopped");
    setTimeout(() => setMsg(null), 4000);
    load();
  };

  const items = data?.items ?? [];
  const pending = items.filter((i) => i.status === "draft");
  const approved = items.filter((i) => i.status === "approved");
  const recent = items.filter((i) => ["sent", "failed", "skipped"].includes(i.status)).sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt)).slice(0, 40);

  const card = (item: Item, editable: boolean) => {
    const d = drafts[item.id] ?? { subject: item.subject ?? "", body: item.body };
    const setD = (patch: Partial<{ subject: string; body: string }>) => setDrafts({ ...drafts, [item.id]: { ...d, ...patch } });
    const changed = d.subject !== (item.subject ?? "") || d.body !== item.body;
    return (
      <div key={item.id} className="card" style={{ padding: "12px 14px", marginBottom: 10, opacity: busy === item.id ? 0.6 : 1 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
          <b style={{ fontSize: 14.5 }}>{item.dealId ? <Link href={`/crm/deal/${item.dealId}`}>{item.dealTitle ?? item.contactName ?? "Deal"}</Link> : item.dealTitle}</b>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>{item.campaign} · step {item.step}{item.mode === "ai" ? " · AI draft" : ""}</span>
          {item.stage && <span className="chip stage" style={{ fontSize: 11.5 }}>{item.stage}</span>}
          {data?.isAdmin && data.scope !== "mine" && <span style={{ fontSize: 12, color: "var(--text-2)" }}>from {item.owner.split("@")[0]}</span>}
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: item.status === "failed" ? "var(--crit)" : "var(--text-3)" }}>
            {item.status === "sent" ? `sent ${fmt(item.sentAt)}` : item.status === "failed" ? `failed: ${item.error}` : item.status === "skipped" ? `skipped${item.error ? ` — ${item.error}` : ""}` : `scheduled ${fmt(item.scheduledFor)}`}
            {item.edited ? " · edited" : ""}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-3)", marginBottom: 6 }}>To {item.contactName ?? ""} &lt;{item.to}&gt; · from {item.owner}</div>
        {editable ? (
          <div style={{ display: "grid", gap: 6 }}>
            {item.channel === "email" && <input className="vmsel" style={{ width: "100%", fontWeight: 600 }} value={d.subject} onChange={(e) => setD({ subject: e.target.value })} placeholder="Subject" />}
            <textarea className="vmsel" style={{ width: "100%", minHeight: 150, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }} value={d.body} onChange={(e) => setD({ body: e.target.value })} />
            {item.aiMeta?.rationale && <div style={{ fontSize: 12, color: "var(--text-3)" }}>🧠 {item.aiMeta.rationale}</div>}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>
            {item.subject && <b style={{ color: "var(--text-1)" }}>{item.subject} — </b>}
            <span style={{ whiteSpace: "pre-wrap" }}>{item.body.slice(0, 280)}{item.body.length > 280 ? "…" : ""}</span>
          </div>
        )}
        {(item.status === "draft" || item.status === "approved" || item.status === "failed") && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            {item.status !== "approved" && <button className="btn primary" style={{ padding: "6px 14px" }} disabled={busy === item.id} onClick={() => act(item, "approve")}>✓ Approve{changed ? " with edits" : ""}</button>}
            <button className="btn" style={{ padding: "6px 14px" }} disabled={busy === item.id} onClick={() => act(item, "approve", { sendNow: true })}>Send now</button>
            {item.status !== "approved" && <button className="btn ghost" style={{ padding: "6px 12px" }} disabled={busy === item.id} onClick={() => act(item, "skip")} title="Don't send this step; continue with the next one">Skip step</button>}
            <button className="btn ghost" style={{ padding: "6px 12px" }} disabled={busy === item.id} onClick={() => act(item, "reject")} title="Don't send; the campaign pauses on this step">Reject</button>
            <button className="btn ghost" style={{ padding: "6px 12px", color: "var(--crit)" }} disabled={busy === item.id} onClick={() => confirm(`Stop the "${item.campaign}" campaign for this deal?`) && act(item, "stop")}>Stop campaign</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="viewhead" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1>📬 Outbox</h1>
        {data?.isAdmin && (
          <select className="vmsel" style={{ width: "auto" }} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="mine">Mine</option>
            <option value="team">Whole team</option>
            {data.reps.map((r) => <option key={r.email} value={`rep:${r.email}`}>{r.name}</option>)}
          </select>
        )}
        {msg && <span style={{ fontSize: 13, color: msg.startsWith("⚠") ? "var(--crit)" : "var(--good)" }}>{msg}</span>}
        <Link href="/settings/campaigns" className="btn ghost" style={{ marginLeft: "auto", padding: "6px 12px", fontSize: 13 }}>📣 Campaigns</Link>
      </div>
      <p className="viewsub">Campaign emails wait here until you approve them. Approve sends at the scheduled time (in the customer's working hours); edit freely first — your edits teach the writer.</p>
      {err && <p className="viewsub" style={{ color: "var(--crit)" }}>{err}</p>}
      {!data && !err && <p className="viewsub">Loading…</p>}
      {data && (
        <>
          <div className="panel-h">Awaiting approval {pending.length ? `(${pending.length})` : ""}</div>
          {pending.length === 0 && <div className="viewsub" style={{ marginTop: 0 }}>Nothing waiting. 🎉</div>}
          {pending.map((i) => card(i, true))}
          {approved.length > 0 && (
            <>
              <div className="panel-h" style={{ marginTop: 18 }}>Approved · scheduled ({approved.length})</div>
              {approved.map((i) => card(i, false))}
            </>
          )}
          {recent.length > 0 && (
            <>
              <div className="panel-h" style={{ marginTop: 18 }}>Recent</div>
              {recent.map((i) => card(i, false))}
            </>
          )}
        </>
      )}
    </div>
  );
}
