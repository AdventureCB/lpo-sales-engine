"use client";

import { useEffect, useState } from "react";
import { openChat } from "./chatDockStore";

interface Banner {
  key: string;
  phone: string;
  name: string | null;
  dealId: string | null;
  preview: string;
}

/**
 * Inbound-text attention layer: polls for new texts to MY Telnyx number
 * (15s, visible tabs only), auto-opens the conversation in the bottom chat
 * dock, and shows a dismissible top banner. Watermark survives navigation
 * (sessionStorage) so history never replays.
 */
export function InboundTextWatcher() {
  const [banners, setBanners] = useState<Banner[]>([]);

  useEffect(() => {
    let stop = false;

    const seenKey = "lpoSmsSeenAt";
    const getSeen = () => {
      try {
        return sessionStorage.getItem(seenKey) ?? new Date().toISOString();
      } catch {
        return new Date().toISOString();
      }
    };
    const setSeen = (iso: string) => {
      try {
        sessionStorage.setItem(seenKey, iso);
      } catch {}
    };
    if (!sessionStorage.getItem(seenKey)) setSeen(new Date().toISOString());

    const dismissLater = (key: string) => {
      setTimeout(() => setBanners((prev) => prev.filter((b) => b.key !== key)), 8000);
    };

    const poll = async () => {
      if (stop || document.hidden) return;
      try {
        const r = await fetch(`/api/texts/inbound-latest?after=${encodeURIComponent(getSeen())}`);
        if (!r.ok) return;
        const d = await r.json();
        const msgs: { id: string; phone: string; body: string | null; hasMedia: boolean; at: string }[] = d.messages ?? [];
        if (msgs.length === 0) return;
        setSeen(msgs[msgs.length - 1].at);

        // One banner + one dock-open per conversation (latest message wins).
        const byPhone = new Map<string, (typeof msgs)[number]>();
        for (const m of msgs) byPhone.set(m.phone, m);
        for (const [phone, m] of byPhone) {
          let name: string | null = null;
          let dealId: string | null = null;
          try {
            const cr = await fetch(`/api/crm/contact-by-phone?phone=${encodeURIComponent(phone)}`);
            if (cr.ok) {
              const cd = await cr.json();
              name = cd.contact?.name ?? null;
              dealId = cd.deal?.crmDealId ?? null;
            }
          } catch {}
          openChat({ phone, name, dealId });
          const key = m.id;
          setBanners((prev) => [
            ...prev.filter((b) => b.phone !== phone).slice(-2),
            { key, phone, name, dealId, preview: (m.body ?? (m.hasMedia ? "📷 Photo" : "")).slice(0, 90) },
          ]);
          dismissLater(key);
        }
      } catch {}
    };

    const iv = setInterval(() => void poll(), 15_000);
    void poll();
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);

  if (banners.length === 0) return null;
  return (
    <div style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 8500, display: "grid", gap: 8, width: "min(440px, 92vw)" }}>
      {banners.map((b) => (
        <div
          key={b.key}
          className="card"
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer", boxShadow: "0 6px 24px rgba(0,0,0,0.35)", border: "1px solid var(--border-soft)" }}
          onClick={() => {
            openChat({ phone: b.phone, name: b.name, dealId: b.dealId });
            setBanners((prev) => prev.filter((x) => x.key !== b.key));
          }}
        >
          <span style={{ fontSize: 20 }}>💬</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{b.name ?? b.phone}</div>
            {b.preview && (
              <div style={{ fontSize: 12.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.preview}</div>
            )}
          </div>
          <button
            className="btn ghost"
            style={{ padding: "2px 8px", fontSize: 12, flexShrink: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              setBanners((prev) => prev.filter((x) => x.key !== b.key));
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
