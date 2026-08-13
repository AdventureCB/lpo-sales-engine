/**
 * Canonical placeholder registry — the single source of truth for every
 * merge token a macro can use. The editor lists these for one-click insert;
 * the composer fills them from the deal/contact/rep at send time.
 */
export const PLACEHOLDERS: { token: string; label: string }[] = [
  { token: "{{first_name}}", label: "First name" },
  { token: "{{last_name}}", label: "Last name" },
  { token: "{{name}}", label: "Full name" },
  { token: "{{deal_title}}", label: "Deal title" },
  { token: "{{truck}}", label: "Truck model" },
  { token: "{{rep_name}}", label: "Your name (rep)" },
];

export interface PlaceholderValues {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  dealTitle?: string | null;
  truck?: string | null;
  repName?: string | null;
}

/** Substitute every known token; unknown data resolves to empty string. */
export function fillPlaceholders(text: string, v: PlaceholderValues): string {
  const first = v.firstName ?? v.name?.split(" ")[0] ?? "";
  return text
    .replaceAll("{{first_name}}", first)
    .replaceAll("{{last_name}}", v.lastName ?? "")
    .replaceAll("{{name}}", v.name?.trim() ?? "")
    .replaceAll("{{deal_title}}", v.dealTitle ?? "")
    .replaceAll("{{truck}}", v.truck ?? "")
    .replaceAll("{{rep_name}}", v.repName ?? "");
}
