// Tiny client-side pubsub for notification items. NotificationBell (always
// mounted in the sidenav) polls /api/notifications and publishes here, so
// other chrome (e.g. the Texts nav badge) can react WITHOUT its own poller.

export interface NotifLite {
  kind: string;
  at: string;
}

let items: NotifLite[] = [];
let outboxPending = 0; // campaign drafts waiting on this user's approval (team total for admins)
const subs = new Set<() => void>();

export function publishNotifs(next: NotifLite[], pending?: number): void {
  items = next;
  if (typeof pending === "number") outboxPending = pending;
  subs.forEach((fn) => fn());
}

export function getNotifs(): NotifLite[] {
  return items;
}

export function getOutboxPending(): number {
  return outboxPending;
}

export function subscribeNotifs(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
