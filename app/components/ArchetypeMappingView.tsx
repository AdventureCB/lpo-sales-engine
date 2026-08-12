"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * Archetype Mapping — the editable taxonomy the AI deal-profiler will
 * classify against. Two catalogs: Archetypes (blended personas with
 * positive/negative traits, observable signals, selling guidance) and
 * Universal attributes (archetype-independent dimensions every profile fills).
 */

interface Archetype {
  id: string;
  key: string;
  name: string;
  emoji: string | null;
  tagline: string | null;
  description: string | null;
  positive_traits: string[];
  negative_traits: string[];
  signals: string[];
  ad_ids: string[];
  selling_approach: string | null;
  avoid: string | null;
  sort_order: number;
  enabled: boolean;
}

interface Attribute {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string;
  value_type: "single_select" | "multi_select" | "scale" | "boolean" | "text";
  options: string[];
  importance: number;
  sort_order: number;
  enabled: boolean;
}

const IMPORTANCE_LABELS = ["Ignore (0)", "Low (1)", "Medium (2)", "High (3)"];

const VALUE_TYPES: { v: Attribute["value_type"]; label: string }[] = [
  { v: "single_select", label: "Single select" },
  { v: "multi_select", label: "Multi select" },
  { v: "scale", label: "Scale" },
  { v: "boolean", label: "Yes / no" },
  { v: "text", label: "Free text" },
];

async function save(entity: "archetype" | "attribute", op: "upsert" | "delete", data: any) {
  const r = await fetch("/api/admin/archetypes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity, op, data }),
  });
  return r.ok;
}

// ── A small add/remove list editor for the text[] fields ───────────────────
function ListField({ label, items, onChange }: { label: string; items: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-3)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {items.map((it, i) => (
          <span key={i} className="chip stage" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {it}
            <button
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              style={{ border: "none", background: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
              title="Remove"
            >
              ×
            </button>
          </span>
        ))}
        {items.length === 0 && <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>None yet.</span>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="vmsel"
          style={{ flex: 1 }}
          placeholder={`Add ${label.toLowerCase()}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn" style={{ padding: "6px 12px", fontSize: 13 }} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

// ── Archetype editor card ──────────────────────────────────────────────────
function ArchetypeCard({ a, onSaved }: { a: Archetype; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Archetype>(a);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => setD(a), [a]);
  const set = (patch: Partial<Archetype>) => setD((c) => ({ ...c, ...patch }));

  const commit = async () => {
    setBusy(true);
    const ok = await save("archetype", "upsert", d);
    setBusy(false);
    if (ok) {
      setOpen(false);
      onSaved();
    }
  };

  return (
    <div className="card" style={{ marginBottom: 10, opacity: d.enabled ? 1 : 0.55 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <span style={{ fontSize: 22 }}>{d.emoji || "🧩"}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{d.name}</div>
          {d.tagline && <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>{d.tagline}</div>}
        </div>
        {!d.enabled && <span className="chip stage">disabled</span>}
        <span style={{ color: "var(--text-3)" }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="vmsel" style={{ width: 60 }} placeholder="Emoji" value={d.emoji ?? ""} onChange={(e) => set({ emoji: e.target.value })} />
            <input className="vmsel" style={{ flex: 1 }} placeholder="Name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <input className="vmsel" placeholder="Tagline" value={d.tagline ?? ""} onChange={(e) => set({ tagline: e.target.value })} />
          <textarea className="vmsel" rows={2} placeholder="Description" value={d.description ?? ""} onChange={(e) => set({ description: e.target.value })} />

          <ListField label="Positive traits" items={d.positive_traits ?? []} onChange={(v) => set({ positive_traits: v })} />
          <ListField label="Negative traits (anti-signals)" items={d.negative_traits ?? []} onChange={(v) => set({ negative_traits: v })} />
          <ListField label="Observable signals (keywords / accessories / behavior)" items={d.signals ?? []} onChange={(v) => set({ signals: v })} />
          <ListField label="Ad IDs to watch (Meta / Google) — strong signal" items={d.ad_ids ?? []} onChange={(v) => set({ ad_ids: v })} />

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-3)", marginBottom: 4, marginTop: 4 }}>Selling approach</div>
            <textarea className="vmsel" rows={2} value={d.selling_approach ?? ""} onChange={(e) => set({ selling_approach: e.target.value })} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-3)", marginBottom: 4 }}>Avoid</div>
            <textarea className="vmsel" rows={2} value={d.avoid ?? ""} onChange={(e) => set({ avoid: e.target.value })} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Enabled
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-3)" }}>
              Order
              <input className="vmsel" type="number" style={{ width: 70 }} value={d.sort_order} onChange={(e) => set({ sort_order: Number(e.target.value) })} />
            </label>
            <button className="btn primary" style={{ marginLeft: "auto" }} disabled={busy} onClick={commit}>
              {busy ? "Saving…" : "Save"}
            </button>
            {confirmDel ? (
              <button className="btn" style={{ color: "var(--crit)" }} onClick={async () => { await save("archetype", "delete", { id: d.id }); onSaved(); }}>
                Confirm delete
              </button>
            ) : (
              <button className="btn ghost" onClick={() => setConfirmDel(true)}>Delete</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Attribute editor row ───────────────────────────────────────────────────
function AttributeCard({ a, onSaved }: { a: Attribute; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Attribute>(a);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => setD(a), [a]);
  const set = (patch: Partial<Attribute>) => setD((c) => ({ ...c, ...patch }));
  const usesOptions = d.value_type === "single_select" || d.value_type === "multi_select" || d.value_type === "scale";

  const commit = async () => {
    setBusy(true);
    const ok = await save("attribute", "upsert", d);
    setBusy(false);
    if (ok) {
      setOpen(false);
      onSaved();
    }
  };

  return (
    <div className="card" style={{ marginBottom: 8, opacity: d.enabled ? 1 : 0.55 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 650 }}>{d.name}</div>
          {d.description && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{d.description}</div>}
        </div>
        <span className="chip stage">{VALUE_TYPES.find((t) => t.v === d.value_type)?.label ?? d.value_type}</span>
        <span style={{ color: "var(--text-3)" }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <input className="vmsel" placeholder="Name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
          <textarea className="vmsel" rows={2} placeholder="Description" value={d.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="vmsel" style={{ flex: 1 }} placeholder="Category" value={d.category} onChange={(e) => set({ category: e.target.value })} />
            <select className="vmsel" value={d.value_type} onChange={(e) => set({ value_type: e.target.value as Attribute["value_type"] })}>
              {VALUE_TYPES.map((t) => (
                <option key={t.v} value={t.v}>{t.label}</option>
              ))}
            </select>
          </div>
          <label style={{ fontSize: 12.5, color: "var(--text-3)", display: "flex", flexDirection: "column", gap: 3 }}>
            Importance (how much this fact weights the &ldquo;enough data&rdquo; meter)
            <select className="vmsel" value={d.importance ?? 1} onChange={(e) => set({ importance: Number(e.target.value) })}>
              {IMPORTANCE_LABELS.map((l, i) => (
                <option key={i} value={i}>{l}</option>
              ))}
            </select>
          </label>
          {usesOptions && <ListField label="Options / values" items={d.options ?? []} onChange={(v) => set({ options: v })} />}

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              Enabled
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-3)" }}>
              Order
              <input className="vmsel" type="number" style={{ width: 70 }} value={d.sort_order} onChange={(e) => set({ sort_order: Number(e.target.value) })} />
            </label>
            <button className="btn primary" style={{ marginLeft: "auto" }} disabled={busy} onClick={commit}>
              {busy ? "Saving…" : "Save"}
            </button>
            {confirmDel ? (
              <button className="btn" style={{ color: "var(--crit)" }} onClick={async () => { await save("attribute", "delete", { id: d.id }); onSaved(); }}>
                Confirm delete
              </button>
            ) : (
              <button className="btn ghost" onClick={() => setConfirmDel(true)}>Delete</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const BLANK_ARCHETYPE: Archetype = {
  id: "", key: "", name: "", emoji: "", tagline: "", description: "",
  positive_traits: [], negative_traits: [], signals: [], ad_ids: [], selling_approach: "", avoid: "",
  sort_order: 999, enabled: true,
};
const BLANK_ATTRIBUTE: Attribute = {
  id: "", key: "", name: "", description: "", category: "General",
  value_type: "single_select", options: [], importance: 1, sort_order: 999, enabled: true,
};

export function ArchetypeMappingView() {
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [tab, setTab] = useState<"archetypes" | "attributes">("archetypes");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/archetypes")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setArchetypes(d.archetypes);
        setAttributes(d.attributes);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);

  const addNew = async () => {
    setAdding(true);
    if (tab === "archetypes") await save("archetype", "upsert", { ...BLANK_ARCHETYPE, name: "New archetype" });
    else await save("attribute", "upsert", { ...BLANK_ATTRIBUTE, name: "New attribute" });
    setAdding(false);
    load();
  };

  // Group attributes by category, preserving sort order.
  const cats: string[] = [];
  const byCat = new Map<string, Attribute[]>();
  for (const at of attributes) {
    if (!byCat.has(at.category)) {
      byCat.set(at.category, []);
      cats.push(at.category);
    }
    byCat.get(at.category)!.push(at);
  }

  return (
    <div>
      <div className="viewhead" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1>🧠 Archetype Mapping</h1>
        <Link href="/settings" style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-3)" }}>← Settings</Link>
      </div>
      <p className="viewsub">
        The taxonomy the AI deal-profiler classifies against. <strong>Archetypes</strong> are blended personas — a deal
        gets a percentage fit across several. <strong>Universal attributes</strong> are the archetype-independent facts
        every profile tries to fill. Edit both freely; changes take effect the next time a profile is built.
      </p>

      <div className="range-toggle" style={{ marginBottom: 16 }}>
        <button className={tab === "archetypes" ? "active" : ""} onClick={() => setTab("archetypes")}>
          Archetypes ({archetypes.length})
        </button>
        <button className={tab === "attributes" ? "active" : ""} onClick={() => setTab("attributes")}>
          Universal attributes ({attributes.length})
        </button>
      </div>

      {loading && <p className="viewsub">Loading…</p>}

      {!loading && tab === "archetypes" && (
        <>
          {archetypes.map((a) => (
            <ArchetypeCard key={a.id} a={a} onSaved={load} />
          ))}
          <button className="btn" disabled={adding} onClick={addNew} style={{ marginTop: 4 }}>
            {adding ? "Adding…" : "+ Add archetype"}
          </button>
        </>
      )}

      {!loading && tab === "attributes" && (
        <>
          {cats.map((cat) => (
            <div key={cat} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-2)", margin: "4px 0 8px", textTransform: "uppercase", letterSpacing: 0.4 }}>
                {cat}
              </div>
              {byCat.get(cat)!.map((at) => (
                <AttributeCard key={at.id} a={at} onSaved={load} />
              ))}
            </div>
          ))}
          <button className="btn" disabled={adding} onClick={addNew} style={{ marginTop: 4 }}>
            {adding ? "Adding…" : "+ Add attribute"}
          </button>
        </>
      )}
    </div>
  );
}
