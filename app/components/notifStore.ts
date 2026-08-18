// Tiny client-side pubsub for notification items. NotificationBell (always
// mounted in the sidenav) polls /api/notifications and publishes here, so
// other chrome (e.g. the Texts nav badge) can react WITHOUT its own poller.

export interface NotifLite {
  kind: string;
  at: string;
}

let items: NotifLite[] = [];
const subs = new Set<() => void>();

export function publishNotifs(next: NotifLite[]): void {
  items = next;
  subs.forEach((fn) => fn());
}

export function getNotifs(): NotifLite[] {
  return items;
}

export function subscribeNotifs(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
