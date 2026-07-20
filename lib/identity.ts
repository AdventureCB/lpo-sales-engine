/**
 * Shared identity matching — used by all three modules.
 * Most integration bugs in systems like this are matching bugs; every
 * email/phone/name comparison anywhere in the app goes through here.
 */

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

/**
 * Normalize a phone number to E.164. US/Canada default: 10-digit numbers
 * get +1. Returns null when the input can't be a real dialable number.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    digits = "+" + digits.slice(1).replace(/\D/g, "");
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }
  digits = digits.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Lowercased, collapsed-whitespace, diacritic-stripped name for fuzzy fallback matching. */
export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const norm = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return norm || null;
}
