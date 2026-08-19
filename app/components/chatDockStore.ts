// Messenger-style chat dock state — module-level pubsub persisted to
// sessionStorage so open conversations survive page navigation (AppShell
// remounts per page). openChat() is callable from anywhere in the app
// (deal page, dialer, Texts page).

export interface ChatSession {
  phone: string; // e164 — the conversation key
  name: string | null;
  dealId: string | null;
  minimized: boolean;
  unread: number; // inbound messages that arrived while minimized
  draft?: string | null; // pre-filled compose text (AI draft) — consumed once by ChatWindow
}

const KEY = "chatDock";
const MAX_OPEN = 4;

let chats: ChatSession[] = [];
let hydrated = false;
const subs = new Set<() => void>();

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    chats = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
  } catch {
    chats = [];
  }
}

function persist() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(chats));
  } catch {}
  subs.forEach((fn) => fn());
}

export function getChats(): ChatSession[] {
  hydrate();
  return chats;
}

export function subscribeChats(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function openChat(opts: { phone: string; name?: string | null; dealId?: string | null; draft?: string | null }): void {
  hydrate();
  const existing = chats.find((c) => c.phone === opts.phone);
  if (existing) {
    existing.minimized = false;
    existing.unread = 0;
    if (opts.name) existing.name = opts.name;
    if (opts.dealId) existing.dealId = opts.dealId;
    if (opts.draft) existing.draft = opts.draft;
  } else {
    chats = [...chats, { phone: opts.phone, name: opts.name ?? null, dealId: opts.dealId ?? null, minimized: false, unread: 0, draft: opts.draft ?? null }];
    // Keep the dock manageable — minimize the oldest once past the cap.
    const open = chats.filter((c) => !c.minimized);
    if (open.length > MAX_OPEN) open[0].minimized = true;
  }
  persist();
}

/** Read-and-clear a session's pre-filled draft (AI-suggested text). */
export function consumeDraft(phone: string): string | null {
  hydrate();
  const c = chats.find((x) => x.phone === phone);
  if (!c?.draft) return null;
  const d = c.draft;
  c.draft = null;
  persist();
  return d;
}

export function closeChat(phone: string): void {
  hydrate();
  chats = chats.filter((c) => c.phone !== phone);
  persist();
}

export function toggleMinimize(phone: string): void {
  hydrate();
  const c = chats.find((x) => x.phone === phone);
  if (!c) return;
  c.minimized = !c.minimized;
  if (!c.minimized) c.unread = 0;
  persist();
}

/** Called by a minimized window's background poll when inbound arrives. */
export function bumpUnread(phone: string, count: number): void {
  hydrate();
  const c = chats.find((x) => x.phone === phone);
  if (!c || !c.minimized || c.unread === count) return;
  c.unread = count;
  persist();
}
