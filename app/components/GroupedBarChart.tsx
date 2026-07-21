"use client";

/**
 * Grouped weekday bar chart, ported from the approved prototype: 4px rounded
 * data-ends anchored to the baseline, 2px gap inside each pair, recessive
 * grid, per-mark hover tooltip. Colors follow the rep (fixed assignment),
 * identity is also carried by the legend rendered above the chart.
 */

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export function GroupedBarChart({
  days,
  series,
  vbW,
  unit,
  onHover,
}: {
  days: string[];
  series: Series[];
  vbW: number;
  unit: string;
  onHover: (tip: { x: number; y: number; html: string } | null) => void;
}) {
  const H = 240;
  const padL = 34;
  const padB = 26;
  const padT = 10;
  const plotW = vbW - padL - 8;
  const plotH = H - padB - padT;
  const maxV = Math.max(4, ...series.flatMap((s) => s.values));
  const yMax = Math.ceil(maxV / 10) * 10 || 4;
  const groups = days.length;
  const groupW = plotW / groups;
  const barW = Math.min(14, (groupW - 14) / series.length);

  const bars: React.ReactNode[] = [];
  days.forEach((d, i) => {
    const gx = padL + i * groupW + groupW / 2;
    series.forEach((s, si) => {
      const v = s.values[i] ?? 0;
      const h = (v / yMax) * plotH;
      const x = gx - (barW + 1) + si * (barW + 2);
      const y = padT + plotH - h;
      const r = Math.min(4, h / 2);
      bars.push(
        <path
          key={`${s.key}-${i}`}
          d={`M${x},${padT + plotH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${padT + plotH} Z`}
          fill={s.color}
          onMouseMove={(e) =>
            onHover({ x: e.clientX, y: e.clientY, html: `${s.label} · ${d}<br><b>${v}</b> ${unit}` })
          }
          onMouseLeave={() => onHover(null)}
        />
      );
    });
  });

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${vbW} ${H}`} preserveAspectRatio="xMidYMid meet">
      {[0, 1, 2].map((g) => {
        const val = Math.round((yMax * g) / 2);
        const y = padT + plotH - (plotH * g) / 2;
        return (
          <g key={g}>
            <line x1={padL} x2={vbW - 8} y1={y} y2={y} stroke={g === 0 ? "#3a3530" : "#2b2724"} strokeWidth={1} />
            <text x={padL - 8} y={y + 4} textAnchor="end" fontSize={10.5} fill="#7d766c">
              {val}
            </text>
          </g>
        );
      })}
      {bars}
      {days.map((d, i) => (
        <text
          key={d}
          x={padL + i * groupW + groupW / 2}
          y={H - 8}
          textAnchor="middle"
          fontSize={10.5}
          fill="#7d766c"
        >
          {d}
        </text>
      ))}
    </svg>
  );
}
