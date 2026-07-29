"use client";

import { useCallback, useEffect, useState } from "react";

interface DealData {
  deal: any;
  timeline: { kind: string; at: string | null; title: string; body: string | null; actor: string | null; done: boolean; due: string | null }[];
  stages: { id: string; name: string; crm_pipelines: { name: string } | null }[];
}

const KIND_ICON: Record<string, string> = {
  call: "📞", sms: "💬", email: "✉️", task: "📋", note: "📝", meeting: "📅", system: "⚙️",
};

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function DealDetailView({ dealId }: { dealId: string }) {
  const [data, setData] = useState<DealData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch(`/api/crm/deal?id=${dealId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(setData)
        .catch((e) => setError(String(e))),
    [dealId]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const update = async (fields: Record<string, string>) => {
    setSaving(true);
    setWarn(null);
    const r = await fetch("/api/crm/deal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: dealId, ...fields }),
    }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      if (d.writeThroughError) {
        setWarn(`Saved here — Pipedrive write-through failed (${d.writeThroughError}). It will match after cutover or a re-sync.`);
      }
      await load();
    } else {
      setWarn("Update failed");
    }
    setSaving(false);
  };

  if (error) return <div className="viewsub">Couldn’t load deal: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const d = data.deal;
  const contact = d.crm_contacts;
  const phones = (contact?.phones ?? []) as { value: string; e164?: string; primary?: boolean }[];
  const emails = (contact?.emails ?? []) as { value: string; primary?: boolean }[];

  return (
    <>
      <div className="viewsub" style={{ marginBottom: 6 }}>
        <a href="/crm" style={{ color: "var(--text-3)", textDecoration: "none" }}>← All deals</a>
      </div>
      <h2 className="viewtitle">{d.title}</h2>
      <div className="viewsub">
        {d.crm_stages?.crm_pipelines?.name} ▸ {d.crm_stages?.name ?? "—"} · {d.status}
        {d.value_cents != null && <> · ${Math.round(d.value_cents / 100).toLocaleString()}</>}
      </div>
      {warn && <div className="viewsub" style={{ color: "var(--warn)" }}>{warn}</div>}

      <div className="split" style={{ marginTop: 0 }}>
        <div>
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="panel-h">Actions</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                className="vmsel"
                style={{ width: "auto" }}
                value={d.stage_id ?? ""}
                onChange={(e) => update({ stageId: e.target.value })}
                disabled={saving}
              >
                {data.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.crm_pipelines?.name} ▸ {s.name}
                  </option>
                ))}
              </select>
              {d.status === "open" ? (
                <>
                  <button className="btn ghost" style={{ padding: "8px 13px", fontSize: 13 }} onClick={() => update({ status: "won" })} disabled={saving}>
                    ✓ Won
                  </button>
                  <button className="btn ghost" style={{ padding: "8px 13px", fontSize: 13 }} onClick={() => update({ status: "lost" })} disabled={saving}>
                    ✗ Lost
                  </button>
                </>
              ) : (
                <button className="btn ghost" style={{ padding: "8px 13px", fontSize: 13 }} onClick={() => update({ status: "open" })} disabled={saving}>
                  Reopen
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input
                className="vmsel"
                style={{ flex: 1 }}
                placeholder="Add a note… (saves here + Pipedrive)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && note.trim()) {
                    void update({ note });
                    setNote("");
                  }
                }}
              />
              <button
                className="btn primary"
                style={{ padding: "8px 14px", fontSize: 13 }}
                disabled={!note.trim() || saving}
                onClick={() => {
                  void update({ note });
                  setNote("");
                }}
              >
                Add note
              </button>
            </div>
          </div>

          <div className="card">
            <div className="panel-h">Timeline</div>
            {data.timeline.length === 0 && (
              <div style={{ color: "var(--text-3)", fontSize: 13 }}>No activity yet.</div>
            )}
            {data.timeline.map((t, i) => (
              <div className="stmt-row" style={{ alignItems: "flex-start" }} key={i}>
                <div style={{ display: "flex", gap: 8 }}>
                  <span>{KIND_ICON[t.kind] ?? "•"}</span>
                  <div>
                    <b style={{ fontSize: 13 }}>{t.title}</b>
                    {t.body && (
                      <div style={{ fontSize: 12.5, color: "var(--text-2)", maxWidth: 480 }}>{t.body}</div>
                    )}
                    {t.actor && <div style={{ fontSize: 11, color: "var(--text-3)" }}>{t.actor}</div>}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0, marginLeft: 10 }}>
                  {fmtWhen(t.at)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="panel-h">Contact</div>
          {contact ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{contact.name}</div>
              {contact.org_name && <div style={{ color: "var(--text-2)", fontSize: 13 }}>{contact.org_name}</div>}
              <div style={{ marginTop: 10 }}>
                {phones.map((p, i) => (
                  <div key={i} style={{ fontSize: 14, fontVariantNumeric: "tabular-nums", padding: "3px 0" }}>
                    📞 {p.e164 ?? p.value}
                    {p.primary && <span style={{ fontSize: 10, color: "var(--text-3)" }}> · primary</span>}
                  </div>
                ))}
                {emails.map((e, i) => (
                  <div key={i} style={{ fontSize: 13, padding: "3px 0", color: "var(--text-2)" }}>
                    ✉️ {e.value}
                  </div>
                ))}
                {phones.length === 0 && emails.length === 0 && (
                  <div style={{ color: "var(--text-3)", fontSize: 13 }}>No contact details.</div>
                )}
              </div>
            </>
          ) : (
            <div style={{ color: "var(--text-3)", fontSize: 13 }}>No linked contact.</div>
          )}
          <div className="panel-h" style={{ marginTop: 16 }}>Record</div>
          <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.8 }}>
            Created {fmtWhen(d.pd_add_time ?? d.created_at)}<br />
            Stage changed {fmtWhen(d.stage_changed_at)}<br />
            Last activity {fmtWhen(d.last_activity_at)}<br />
            Pipedrive #{d.pipedrive_deal_id ?? "—"}
          </div>
        </div>
      </div>
    </>
  );
}
