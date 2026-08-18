"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getNotifs, subscribeNotifs } from "./notifStore";

const SEEN_KEY = "textsSeenAt";

/**
 * Unread-texts pill on the "Text" nav item. Counts inbound-sms notifications
 * newer than the rep's last visit to /texts (per machine); visiting the page
 * clears it. Data comes from the bell's poll via notifStore — no own fetch.
 */
export function TextNavBadge() {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const compute = () => {
      if (pathname === "/texts") {
        try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch {}
        setCount(0);
        return;
      }
      let seenAt = "";
      try { seenAt = localStorage.getItem(SEEN_KEY) ?? ""; } catch {}
      setCount(getNotifs().filter((n) => n.kind === "sms" && n.at > seenAt).length);
    };
    compute();
    return subscribeNotifs(compute);
  }, [pathname]);

  if (count === 0) return null;
  return (
    <span
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
      {count > 9 ? "9+" : count}
    </span>
  );
}
