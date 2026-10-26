"use client";

import { useEffect, useState } from "react";
import { getOutboxPending, subscribeNotifs } from "./notifStore";

/**
 * "Awaiting approval" pill on the "Outbox" nav item: campaign drafts waiting
 * on this rep (team total for admins). Fed by the bell's 45s poll via
 * notifStore — no own fetch. Unlike the Texts pill it doesn't clear on visit:
 * the number is work still owed, so it stays until the drafts are handled.
 */
export function OutboxNavBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const compute = () => setCount(getOutboxPending());
    compute();
    return subscribeNotifs(compute);
  }, []);

  if (count === 0) return null;
  return (
    <span
      title={`${count} campaign message${count === 1 ? "" : "s"} awaiting approval`}
      style={{
        marginLeft: "auto",
        background: "var(--accent)",
        color: "#fff",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        lineHeight: 1,
        padding: "3px 6px",
        minWidth: 17,
        textAlign: "center",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
