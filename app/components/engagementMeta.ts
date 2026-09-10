// Shared engagement slice metadata — one source of truth for the admin
// Engagement page AND the public scoreboard pies (same category = same color
// everywhere, never re-hued per view).

export const ENG_COLORS = {
  talking: "#4cc44c",
  inbound: "#2bb8a1",
  dialing: "#d95b31",
  between: "#4a94ec",
  other: "#9c9285",
  idle: "rgba(150,140,125,0.25)",
};

export const SURFACES: Record<string, { label: string; color: string }> = {
  "/dialer": { label: "In dialer", color: "#4a94ec" },
  "/crm/deal": { label: "Deal pages", color: "#6ab0f3" },
  "/lists": { label: "Sprint lists", color: "#3d7cc9" },
  "/hot-list": { label: "Hot list", color: "#2f64a3" },
  "/texts": { label: "Texting", color: "#8e6ae0" },
  "/crm": { label: "CRM list", color: "#b0a79a" },
  "/calendar": { label: "Calendar", color: "#a29782" },
};
export const surfaceMeta = (surf: string) =>
  SURFACES[surf] ?? { label: surf.replace(/^\//, "") || "other", color: "#9c9285" };

export const TOOL_META: Record<string, { label: string; color: string }> = {
  gorgias: { label: "🎧 Gorgias", color: "#5a8bd6" },
  shopify: { label: "🛍 Shopify", color: "#7aa85a" },
  clickup: { label: "✅ ClickUp", color: "#a06bc9" },
  calendly: { label: "🗓 Calendly", color: "#4cb0a6" },
  browser: { label: "🌐 Browser", color: "#b0894c" },
  ops: { label: "🏔 Lone Peak Ops", color: "#c96b6b" },
};
export const toolMeta = (tool: string, cfg?: { label: string; emoji: string }) =>
  cfg
    ? { label: `${cfg.emoji} ${cfg.label}`, color: TOOL_META[tool]?.color ?? "#8a8fa3" }
    : TOOL_META[tool] ?? { label: `🧰 ${tool.charAt(0).toUpperCase()}${tool.slice(1)}`, color: "#8a8fa3" };

export interface EngSliceSource {
  talkingS: number;
  inboundTalkS: number;
  dialingS: number;
  idleS: number;
  betweenS: number;
  otherS: number;
  surfaces?: Record<string, number>;
  tools?: Record<string, number>;
}

/** The same slice construction the Engagement page uses, as data. */
export function buildSlices(
  r: EngSliceSource,
  toolLabels?: Record<string, { label: string; emoji: string }>
): { label: string; s: number; color: string }[] {
  const surfEntries = Object.entries(r.surfaces ?? {}).sort((a, b) => b[1] - a[1]);
  const hasSurfaces = surfEntries.length > 0;
  return [
    { label: "Talking (outbound)", s: r.talkingS - r.inboundTalkS, color: ENG_COLORS.talking },
    { label: "Inbound calls", s: r.inboundTalkS, color: ENG_COLORS.inbound },
    { label: "Dialing", s: r.dialingS, color: ENG_COLORS.dialing },
    ...(hasSurfaces
      ? surfEntries.map(([surf, s]) => ({ label: surfaceMeta(surf).label, s, color: surfaceMeta(surf).color }))
      : [
          { label: "Between calls", s: r.betweenS, color: ENG_COLORS.between },
          { label: "Other work", s: r.otherS, color: ENG_COLORS.other },
        ]),
    ...Object.entries(r.tools ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([tool, s]) => ({ label: toolMeta(tool, toolLabels?.[tool]).label, s, color: toolMeta(tool, toolLabels?.[tool]).color })),
    { label: "Idle", s: r.idleS, color: ENG_COLORS.idle },
  ].filter((x) => x.s > 0);
}
