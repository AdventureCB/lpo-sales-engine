/**
 * Lazy env accessor — routes fail loudly at request time with the missing
 * key's name instead of crashing the whole build at import time.
 */
export function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export function envOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}
