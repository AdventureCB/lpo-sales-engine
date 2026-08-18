"use client";

import { useEffect } from "react";
import { ChatWindow } from "../../components/ChatWindow";

export function StandaloneChat({ phone, name, dealId }: { phone: string; name: string | null; dealId: string | null }) {
  useEffect(() => {
    document.title = `💬 ${name ?? phone} · LPO`;
  }, [name, phone]);
  return (
    <ChatWindow
      phone={phone}
      name={name}
      dealId={dealId}
      standalone
      header={
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", background: "var(--surface-2)" }}>
          <b style={{ fontSize: 14.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name ?? phone}</b>
          {name && <span style={{ color: "var(--text-3)", fontSize: 13 }}>{phone}</span>}
          {dealId && (
            <a href={`/crm/deal/${dealId}`} target="_blank" rel="noreferrer" className="btn ghost" style={{ padding: "4px 10px", fontSize: 12.5 }}>
              📋 Deal
            </a>
          )}
        </div>
      }
    />
  );
}
