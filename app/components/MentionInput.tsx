"use client";

import { useRef, useState } from "react";
import { useRoster } from "./useRoster";

/**
 * Textarea with @mention autocomplete: typing "@" (plus letters) pops a
 * roster picker; picking inserts "@Full Name ". The server re-extracts
 * mentions on save, so the inserted text is the only contract.
 */
export default function MentionInput({
  value,
  onChange,
  placeholder,
  rows = 4,
  autoFocus,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  style?: React.CSSProperties;
}) {
  const roster = useRoster();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [drop, setDrop] = useState<{ q: string; start: number } | null>(null);

  // An "@token" is live when the caret sits right after @word-chars.
  const updateDrop = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|[\s(])@([\w ]{0,24})$/.exec(before);
    if (!m) return setDrop(null);
    setDrop({ q: m[2].toLowerCase(), start: caret - m[2].length - 1 });
  };

  const matches = drop
    ? roster.mentionable.filter((u) => u.name.toLowerCase().includes(drop.q) || u.email.toLowerCase().startsWith(drop.q)).slice(0, 6)
    : [];

  const pick = (name: string) => {
    if (!drop) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, drop.start)}@${name} ${value.slice(caret)}`;
    onChange(next);
    setDrop(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = drop.start + name.length + 2;
        el.selectionStart = el.selectionEnd = pos;
      }
    });
  };

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={ref}
        className="vmsel"
        rows={rows}
        style={{ resize: "vertical", width: "100%", ...style }}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          updateDrop(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyUp={(e) => updateDrop(value, (e.target as HTMLTextAreaElement).selectionStart ?? value.length)}
        onBlur={() => setTimeout(() => setDrop(null), 150)}
      />
      {drop && matches.length > 0 && (
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: "calc(100% + 4px)",
            zIndex: 50,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
            minWidth: 200,
            overflow: "hidden",
          }}
        >
          {matches.map((u) => (
            <div
              key={u.email}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u.name);
              }}
              style={{ padding: "7px 12px", fontSize: 13.5, cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--surface-3)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            >
              <b>@{u.name}</b>
              <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{u.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
