"use client";

import { useEffect, useState } from "react";
import { GroupedBarChart, type Series } from "./GroupedBarChart";

// Fixed categorical assignment (never cycled): Parker rust, Jackson blue —
// the CVD-validated pair from the prototype. Extra reps get the fallbacks.
const SERIES_COLORS: Record<string, string> = {
  parker: "var(--series-parker)",
  jackson: "var(--series-jackson)",
};
const FALLBACK_COLORS = ["#0ca30c", "#fab219"];

interface ScoreboardData {
  reps: { key: string; name: string; initials: string }[];
  days: string[];
  ranges: Record<
    string,
    {
      sub: string;
      textsIn: number;
      dials: Record<string, number[]>;
      conv: Record<string, number[]>;
      tiles: Record<
        string,
        {
          dials: number;
          conv: number;
          convIn: number;
          vm: number;
          texts: number;
          textsIn: number;
          talk: string;
          rate: string;
          comm: string;
        }
      >;
    }
  >;
}

const RANGE_LABELS: [string, string][] = [
  ["day", "Today"],
  ["week", "This week"],
  ["month", "Month"],
];

// Connect rate = conv ÷ dials — both shown, same numerator, no surprises.
// Inbound answered calls are annotated on the Conversations tile, not mixed in.
const TILE_LABELS: [keyof ScoreboardData["ranges"][string]["tiles"][string], string][] = [
  ["dials", "Dials"],
  ["conv", "Conversations"],
  ["vm", "VMs left"],
  ["texts", "Texts sent"],
  ["textsIn", "Texts received"],
  ["talk", "Talk time"],
  ["rate", "Connect rate"],
  ["comm", "Commission MTD"],
];

export function ScoreboardView() {
  const [data, setData] = useState<ScoreboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("week");
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);

  useEffect(() => {
    fetch("/api/scoreboard")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="viewsub">Couldn’t load scoreboard: {error}</div>;
  if (!data) return <div className="viewsub">Loading…</div>;

  const D = data.ranges[range];
  const colorFor = (key: string, i: number) =>
    SERIES_COLORS[key] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
  const mkSeries = (metric: Record<string, number[]>): Series[] =>
    data.reps.map((r, i) => ({
      key: r.key,
      label: r.name.split(" ")[0],
      color: colorFor(r.key, i),
      values: metric[r.key] ?? [],
    }));

  const legend = (
    <div className="legend">
      {data.reps.map((r, i) => (
        <span key={r.key}>
          <span className="sw" style={{ background: colorFor(r.key, i) }} />
          {r.name.split(" ")[0]}
        </span>
      ))}
    </div>
  );

  return (
    <>
      <h2 className="viewtitle">Team scoreboard</h2>
      <div className="viewsub">Outbound activity from Quo · conversions from Pipedrive + Shopify journeys</div>
      <div className="range-toggle">
        {RANGE_LABELS.map(([key, label]) => (
          <button key={key} className={range === key ? "active" : ""} onClick={() => setRange(key)}>
            {label}
          </button>
        ))}
      </div>
      {D.textsIn > 0 && (
        <div className="viewsub" style={{ marginTop: -8 }}>
          +{D.textsIn} text{D.textsIn === 1 ? "" : "s"} received on shared lines
        </div>
      )}

      {data.reps.map((r, i) => {
        const t = D.tiles[r.key];
        return (
          <div className="repline" key={r.key}>
            <div className="who">
              <div className="avatar" style={{ background: colorFor(r.key, i) }}>
                {r.initials}
              </div>
              {r.name}
            </div>
            {TILE_LABELS.map(([field, label]) => (
              <div className="stat-tile" key={label}>
                <div className="n">{t?.[field] ?? "—"}</div>
                <div className="l">{label}</div>
                {field === "conv" && (t?.convIn ?? 0) > 0 && (
                  <div className="d">
                    +{t.convIn} inbound · {t.conv + t.convIn} total
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      <div className="charts">
        <div className="card chart-card">
          <h3>Dials by day</h3>
          <div className="sub">{D.sub}</div>
          {legend}
          <GroupedBarChart days={data.days} series={mkSeries(D.dials)} vbW={620} unit="dials" onHover={setTip} />
        </div>
        <div className="card chart-card">
          <h3>Conversations by day</h3>
          <div className="sub">Live two-way calls (voicemails excluded)</div>
          {legend}
          <GroupedBarChart days={data.days} series={mkSeries(D.conv)} vbW={400} unit="conversations" onHover={setTip} />
        </div>
      </div>

      {tip && (
        <div
          className="tooltip"
          style={{ left: tip.x + 14, top: tip.y - 10 }}
          dangerouslySetInnerHTML={{ __html: tip.html }}
        />
      )}
    </>
  );
}
