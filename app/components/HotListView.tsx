"use client";

import React, { useCallback, useEffect, useState } from "react";

const SRC_CHIP: Record<string, { bg: string; color: string; label: string }> = {
  klaviyo: { bg: "rgba(201,80,46,.13)", color: "#e88a6b", label: "Klaviyo" },
  pipedrive: { bg: "rgba(57,135,229,.13)", color: "#7db4f0", label: "Pipedrive" },
  shopify: { bg: "rgba(12,163,12,.12)", color: "#5ecf5e", label: "Shopify" },
  quo: { bg: "rgba(250,178,25,.13)", color: "#f6c85f", label: "Quo" },
};

function SourceChip({ source }: { source: string }) {
  const c = SRC_CHIP[source] ?? { bg: "var(--surface-3)", color: "var(--text-2)", label: source };
  return (
    <span className="chip stage" style={{ background: c.bg, color: c.color }}>
      {c.label}
    </span>
  );
}

interface Flag {
  id: string;
  deal_id: number;
  reason: string;
  deal_title: string | null;
  owner_name: string | null;
  person_phone?: string | null;
  flagged_at: string;
  cleared_at: string | null;
  cooldown_until: string | null;
}

function flagStatus(f: Flag): string {
  if (!f.cleared_at) return "🔥 Active";
  if (f.cooldown_until && new Date(f.cooldown_until) > new Date())
    return `⏳ Cooldown to ${fmtWhen(f.cooldown_until).split(",")[0]}`;
  return `Cleared ${fmtWhen(f.cleared_at)}`;
}

interface FeedItem {
  source: string;
  type: string;
  person_email: string | null;
  occurred_at: string;
  meta?: Record<string, unknown> | null;
}

/** "opened 'Your build is ready' · Summer promo" from the stored meta. */
function eventDetail(e: FeedItem): string {
  const m = e.meta ?? {};
  const parts: string[] = [];
  if (m["Subject"]) parts.push(`“${m["Subject"]}”`);
  if (m["Campaign Name"] && m["Campaign Name"] !== m["Subject"]) parts.push(String(m["Campaign Name"]));
  if (m["URL"]) parts.push(String(m["URL"]).replace(/^https?:\/\//, "").slice(0, 60));
  if (m["$value"]) parts.push(`$${m["$value"]}`);
  if (m["subject"]) parts.push(`“${m["subject"]}”`); // pipedrive threads
  return parts.join(" · ");
}

const TYPE_LABEL: Record<string, string> = {
  email_open: "opened email",
  email_click: "clicked email",
  builder_save: "saved a build",
  checkout_started: "started checkout",
};

interface HotData {
  tiles: { flaggedNow: number; newToday: number; signals24h: number };
  flags: Flag[];
  feed: FeedItem[];
  rules: Record<string, number>;
}

const RULE_FIELDS: [string, string][] = [
  ["opens_in_window", "Email opens ≥"],
  ["opens_window_days", "…within (days)"],
  ["click_window_hours", "Any click within (hours)"],
  ["distinct_signal_types", "Distinct signal types ≥"],
  ["distinct_signal_window_hours", "…within (hours)"],
  ["cooldown_days", "Re-flag cooldown (days)"],
];

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HotListView({ isAdmin = false }: { isAdmin?: boolean }) {
  const [data, setData] = useState<HotData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<Record<string, number>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [dealEvents, setDealEvents] = useState<Record<number, FeedItem[]>>({});
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<Flag[] | null>(null);

  const runSearch = async () => {
    const term = searchTerm.trim();
    if (term.length < 2) {
      setSearchResults(null);
      return;
    }
    const r = await fetch(`/api/hotlist/search?term=${encodeURIComponent(term)}`).catch(() => null);
    if (r?.ok) setSearchResults((await r.json()).results);
  };

  const toggleExpand = (dealId: number) => {
    if (expanded === dealId) {
      setExpanded(null);
      return;
    }
    setExpanded(dealId);
    if (!dealEvents[dealId]) {
      fetch(`/api/hotlist/events?dealId=${dealId}`)
        .then((r) => r.json())
        .then((d) => setDealEvents((prev) => ({ ...prev, [dealId]: d.events ?? [] })));
    }
  };

  const load = useCallback(() => {
    fetch("/api/hotlist")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: HotData) => {
        setData(d);
        setRules((prev) => (Object.keys(prev).length ? prev : d.rules));
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) return <div className="viewsub">Couldn’t load hot list: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const active = data.flags.filter((f) => !f.cleared_at);

  const dismiss = async (flagId: string) => {
    await fetch("/api/hotlist/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flagId }),
    });
    load();
  };

  const saveRules = async () => {
    setSaveState("saving");
    const res = await fetch("/api/hotlist/rules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data.rules, ...rules }),
    });
    setSaveState(res.ok ? "saved" : "idle");
    setTimeout(() => setSaveState("idle"), 2000);
  };

  return (
    <>
      <h2 className="viewtitle">🔥 Hot list</h2>
      <div className="viewsub">
        Deals with recent buying signals — Klaviyo email opens/clicks (more sources coming) ·
        flagged deals get a &quot;🔥 Hot&quot; label + due-today task in Pipedrive
      </div>

      <div className="comm-tiles">
        <div className="stat-tile">
          <div className="n" style={{ color: "var(--accent-hover)" }}>{data.tiles.flaggedNow}</div>
          <div className="l">Flagged now</div>
        </div>
        <div className="stat-tile">
          <div className="n">{data.tiles.newToday}</div>
          <div className="l">New today</div>
        </div>
        <div className="stat-tile">
          <div className="n">{data.tiles.signals24h}</div>
          <div className="l">Signals · 24h</div>
        </div>
      </div>

      <div className="split" style={{ marginTop: 0 }}>
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input
              className="vmsel"
              style={{ flex: 1 }}
              placeholder="Search hot-list history (anyone ever flagged)…"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                if (!e.target.value.trim()) setSearchResults(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
            />
            <button className="btn" style={{ padding: "8px 14px" }} onClick={runSearch}>🔍</button>
            {searchResults && (
              <button
                className="btn ghost"
                style={{ padding: "8px 12px" }}
                onClick={() => {
                  setSearchResults(null);
                  setSearchTerm("");
                }}
              >
                ✕
              </button>
            )}
          </div>
          {searchResults && (
            <div className="card" style={{ padding: "6px 12px", marginBottom: 18 }}>
              <table className="data">
                <thead>
                  <tr><th>Deal</th><th>Phone</th><th>Owner</th><th>Last reason</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {searchResults.length === 0 && (
                    <tr><td colSpan={5} style={{ color: "var(--text-3)", padding: "14px 10px" }}>No matches in hot-list history.</td></tr>
                  )}
                  {searchResults.map((f) => (
                    <tr key={f.id}>
                      <td><b>{f.deal_title ?? `Deal #${f.deal_id}`}</b></td>
                      <td style={{ whiteSpace: "nowrap" }}>{f.person_phone ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{f.owner_name ?? "—"}</td>
                      <td style={{ fontSize: 12.5, color: "var(--text-2)" }}>{f.reason}</td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{flagStatus(f)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card" style={{ padding: "6px 12px" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Owner</th>
                  <th>Why it&apos;s hot</th>
                  <th>Flagged</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {active.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ color: "var(--text-3)", padding: "18px 10px" }}>
                      No deals flagged — signals are swept every 15 minutes.
                    </td>
                  </tr>
                )}
                {active.map((f) => (
                  <React.Fragment key={f.id}>
                    <tr onClick={() => toggleExpand(f.deal_id)} style={{ cursor: "pointer" }}>
                      <td>
                        <span style={{ color: "var(--text-3)", marginRight: 6 }}>
                          {expanded === f.deal_id ? "▾" : "▸"}
                        </span>
                        <b>{f.deal_title ?? `Deal #${f.deal_id}`}</b>
                        {f.person_phone && (
                          <div style={{ fontSize: 12, color: "var(--text-2)", marginLeft: 18 }}>
                            {f.person_phone}
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{f.owner_name ?? "—"}</td>
                      <td style={{ fontSize: 12.5, color: "var(--text-2)" }}>{f.reason}</td>
                      <td style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>
                        {fmtWhen(f.flagged_at)}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          className="btn ghost"
                          style={{ padding: "6px 10px", fontSize: 12 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            dismiss(f.id);
                          }}
                        >
                          Dismiss
                        </button>
                      </td>
                    </tr>
                    {expanded === f.deal_id && (
                      <tr>
                        <td colSpan={5} style={{ background: "var(--surface-2)", padding: "10px 14px" }}>
                          {!dealEvents[f.deal_id] && (
                            <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>Loading…</span>
                          )}
                          {dealEvents[f.deal_id]?.length === 0 && (
                            <span style={{ color: "var(--text-3)", fontSize: 12.5 }}>
                              No stored events for this deal.
                            </span>
                          )}
                          {dealEvents[f.deal_id]?.map((e, i) => (
                            <div
                              key={i}
                              style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0", fontSize: 12.5 }}
                            >
                              <span style={{ color: "var(--text-3)", whiteSpace: "nowrap", minWidth: 110 }}>
                                {fmtWhen(e.occurred_at)}
                              </span>
                              <SourceChip source={e.source} />
                              <span style={{ color: "var(--text-1)" }}>{TYPE_LABEL[e.type] ?? e.type}</span>
                              <span style={{ color: "var(--text-2)" }}>{eventDetail(e)}</span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {isAdmin && (
          <div className="card" style={{ marginTop: 18 }}>
            <div className="panel-h">Flag rules (config, not code)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {RULE_FIELDS.map(([key, label]) => (
                <div className="field" style={{ margin: 0 }} key={key}>
                  <label>{label}</label>
                  <input
                    type="number"
                    value={rules[key] ?? ""}
                    onChange={(e) => setRules({ ...rules, [key]: Number(e.target.value) })}
                  />
                </div>
              ))}
            </div>
            <button
              className="btn primary"
              style={{ marginTop: 14 }}
              onClick={saveRules}
              disabled={saveState === "saving"}
            >
              {saveState === "saved" ? "✓ Saved — applies next sweep" : "Save rules"}
            </button>
          </div>
          )}
        </div>

        <div className="card">
          <div className="panel-h">Live signal feed</div>
          {data.feed.length === 0 && (
            <div style={{ color: "var(--text-3)", fontSize: 13 }}>No signals yet.</div>
          )}
          {data.feed.map((s, i) => (
            <div className="stmt-row" style={{ alignItems: "flex-start" }} key={i}>
              <div>
                <b style={{ fontSize: 13 }}>{s.person_email ?? "unknown"}</b>
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                  {TYPE_LABEL[s.type] ?? s.type.replace("_", " ")}
                  {eventDetail(s) && (
                    <span style={{ color: "var(--text-2)" }}> — {eventDetail(s)}</span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 10 }}>
                <SourceChip source={s.source} />
                <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 3 }}>
                  {fmtWhen(s.occurred_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
