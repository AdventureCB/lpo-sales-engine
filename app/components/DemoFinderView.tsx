"use client";

import { useState } from "react";
import { newOutboundCall } from "./phoneClient";

/**
 * 🏕 Demo Finder — reps type a prospect's area (zip) and get nearby camper
 * owners to ask about hosting/showing a demo. Owner says yes → mark willing
 * (warm). Call via the softphone, text inline, or open their Shopify order to
 * see accessories. V1/V2 badge per owner.
 */

interface Owner {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  miles: number;
  version: "v1" | "v2" | "both";
  willing: boolean;
  orderName: string | null;
  orderAt: string | null;
  items: { sku: string | null; title: string | null; qty: number }[];
  contactId: string | null;
  shopifyUrl: string | null;
}

function miles(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const VERSION_BADGE: Record<string, { label: string; color: string }> = {
  v1: { label: "V1", color: "#7c8aa0" },
  v2: { label: "V2", color: "#3aa0e8" },
  both: { label: "V1+V2", color: "#9a7be0" },
};

export function DemoFinderView() {
  const [zip, setZip] = useState("");
  const [radius, setRadius] = useState(150);
  const [version, setVersion] = useState<"all" | "v1" | "v2">("all");
  const [willingOnly, setWillingOnly] = useState(false);
  const [owners, setOwners] = useState<Owner[] | null>(null);
  const [origin, setOrigin] = useState<[number, number] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const search = async () => {
    if (!/\d{5}/.test(zip)) {
      setErr("Enter a 5-digit zip");
      return;
    }
    setLoading(true);
    setErr(null);
    const qs = new URLSearchParams({ zip, radius: String(radius) });
    if (version !== "all") qs.set("version", version);
    if (willingOnly) qs.set("willing", "1");
    const r = await fetch(`/api/crm/demo-finder?${qs}`).catch(() => null);
    setLoading(false);
    if (!r?.ok) {
      const d = await r?.json().catch(() => ({}));
      setErr(d?.error ?? "Search failed");
      setOwners(null);
      return;
    }
    const d = await r.json();
    setOrigin(d.origin ? [d.origin.lat, d.origin.lng] : null);
    setOwners(d.owners);
  };

  return (
    <>
      <div className="viewhead"><h1>🏕 Demo Finder</h1></div>
      <p className="viewsub">
        Find camper owners near your prospect who might host or show a demo. When an owner agrees, mark them
        willing — they&apos;ll show as warm for next time.
      </p>

      <div className="card" style={{ padding: "14px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="vmsel"
          style={{ width: 130 }}
          placeholder="Prospect zip"
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          inputMode="numeric"
        />
        <select className="vmsel" style={{ width: "auto" }} value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
          {[50, 100, 150, 250, 500].map((r) => <option key={r} value={r}>within {r} mi</option>)}
        </select>
        <select className="vmsel" style={{ width: "auto" }} value={version} onChange={(e) => setVersion(e.target.value as any)}>
          <option value="all">V1 & V2</option>
          <option value="v1">V1 only</option>
          <option value="v2">V2 only</option>
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13.5, cursor: "pointer" }}>
          <input type="checkbox" checked={willingOnly} onChange={(e) => setWillingOnly(e.target.checked)} />
          ⭐ Willing only
        </label>
        <button className="btn primary" onClick={() => void search()} disabled={loading}>
          {loading ? "Searching…" : "Find owners"}
        </button>
      </div>

      {err && <div className="viewsub" style={{ color: "var(--crit)" }}>{err}</div>}
      {owners && (
        <div className="viewsub">{owners.length} owner{owners.length === 1 ? "" : "s"} within {radius} miles</div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {owners?.map((o) => (
          <OwnerCard
            key={o.id}
            owner={o}
            origin={origin}
            onAddr={(city, state, zip, m) =>
              setOwners((prev) =>
                (prev ?? [])
                  .map((x) => (x.id === o.id ? { ...x, city, state, zip, miles: m ?? x.miles } : x))
                  .sort((a, b) => a.miles - b.miles)
              )
            }
          />
        ))}
      </div>
    </>
  );
}

function OwnerCard({
  owner,
  origin,
  onAddr,
}: {
  owner: Owner;
  origin: [number, number] | null;
  onAddr: (city: string, state: string, zip: string, m: number | null) => void;
}) {
  const [willing, setWilling] = useState(owner.willing);
  const [open, setOpen] = useState(false);
  const [texting, setTexting] = useState(false);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [editAddr, setEditAddr] = useState(false);
  const [aCity, setACity] = useState(owner.city ?? "");
  const [aState, setAState] = useState(owner.state ?? "");
  const [aZip, setAZip] = useState(owner.zip ?? "");
  const badge = VERSION_BADGE[owner.version] ?? VERSION_BADGE.v1;

  const toggleWilling = async () => {
    const next = !willing;
    setWilling(next);
    await fetch("/api/crm/demo-finder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: owner.id, willing: next }),
    }).catch(() => {});
  };
  const call = () => {
    if (owner.phone) void newOutboundCall(owner.phone).catch(() => {});
  };
  const sendText = async () => {
    if (!owner.phone || !msg.trim()) return;
    const r = await fetch("/api/texts/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: owner.phone, body: msg.trim(), contactId: owner.contactId ?? undefined }),
    }).catch(() => null);
    setNote(r?.ok ? "✓ Text sent" : "Text failed");
    if (r?.ok) { setMsg(""); setTexting(false); }
    setTimeout(() => setNote(null), 4000);
  };

  const saveAddr = async () => {
    if (!/\d{5}/.test(aZip)) { setNote("Enter a 5-digit zip"); return; }
    const r = await fetch("/api/crm/demo-finder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: owner.id, op: "address", city: aCity, state: aState, zip: aZip }),
    }).catch(() => null);
    if (!r?.ok) { setNote("Address update failed"); return; }
    const d = await r.json();
    const m = origin && d.lat != null ? miles(origin, [d.lat, d.lng]) : null;
    onAddr(aCity.trim(), aState.trim().toUpperCase().slice(0, 2), d.zip, m);
    setEditAddr(false);
    setNote("✓ Address updated" + (m != null ? ` — ${m} mi` : ""));
    setTimeout(() => setNote(null), 4000);
  };

  return (
    <div className="card" style={{ padding: "12px 14px", border: willing ? "1px solid var(--good, #3aa76d)" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>{owner.name}</b>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "#fff", background: badge.color, borderRadius: 5, padding: "1px 7px" }}>{badge.label}</span>
        {willing && <span style={{ fontSize: 12, color: "var(--good, #3aa76d)", fontWeight: 700 }}>⭐ Willing</span>}
        <span style={{ fontSize: 13, color: "var(--text-2)" }}>
          {owner.city}{owner.state ? `, ${owner.state}` : ""} · <b>{owner.miles} mi</b>
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          {owner.phone && <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={call}>📞 Call</button>}
          {owner.phone && <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => setTexting((v) => !v)}>💬 Text</button>}
          {owner.shopifyUrl && <a href={owner.shopifyUrl} target="_blank" rel="noreferrer" className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }}>🛍 Shopify →</a>}
          <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => setEditAddr((v) => !v)} title="Customer moved? Update their location">
            ✎ Address
          </button>
          <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide order" : "View order"}
          </button>
          <button
            className={`btn ${willing ? "" : "primary"}`}
            style={{ padding: "4px 12px", fontSize: 13 }}
            onClick={() => void toggleWilling()}
          >
            {willing ? "Unmark" : "⭐ Mark willing"}
          </button>
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-3)", marginTop: 3 }}>
        {owner.phone ?? "no phone"} {owner.email ? `· ${owner.email}` : ""}
        {owner.orderName ? ` · order ${owner.orderName}${owner.orderAt ? ` (${new Date(owner.orderAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })})` : ""}` : ""}
      </div>
      {texting && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            className="vmsel"
            style={{ flex: 1 }}
            placeholder={`Text ${owner.name.split(" ")[0]}…`}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void sendText()}
            autoFocus
          />
          <button className="btn primary" style={{ padding: "6px 14px" }} onClick={() => void sendText()} disabled={!msg.trim()}>Send</button>
        </div>
      )}
      {editAddr && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="vmsel" style={{ width: 160 }} placeholder="City" value={aCity} onChange={(e) => setACity(e.target.value)} />
          <input className="vmsel" style={{ width: 60 }} placeholder="ST" value={aState} onChange={(e) => setAState(e.target.value)} maxLength={2} />
          <input className="vmsel" style={{ width: 90 }} placeholder="Zip" value={aZip} onChange={(e) => setAZip(e.target.value)} inputMode="numeric" />
          <button className="btn primary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => void saveAddr()}>Save</button>
          <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 13 }} onClick={() => setEditAddr(false)}>Cancel</button>
          <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>Billing address by default; override if they moved.</span>
        </div>
      )}
      {note && <div style={{ fontSize: 12.5, color: "var(--good)", marginTop: 4 }}>{note}</div>}
      {open && (
        <div style={{ marginTop: 8, borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 4 }}>
            Camper order {owner.orderName} — {owner.shopifyUrl && <a href={owner.shopifyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>full history in Shopify →</a>}
          </div>
          {owner.items.map((it, i) => (
            <div key={i} style={{ fontSize: 13, padding: "1px 0" }}>
              • {it.title}{it.qty && it.qty > 1 ? ` ×${it.qty}` : ""}{it.sku ? <span style={{ color: "var(--text-3)" }}> ({it.sku})</span> : null}
            </div>
          ))}
          {owner.items.length === 0 && <div style={{ fontSize: 13, color: "var(--text-3)" }}>No line items stored.</div>}
        </div>
      )}
    </div>
  );
}
