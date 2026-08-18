"use client";

import { useEffect, useRef, useState } from "react";
import { isHtml, linkifyHtml } from "@/lib/richtext";
import { PLACEHOLDERS } from "@/lib/placeholders";

/**
 * Zero-dependency rich-text editor (contentEditable + execCommand) used by the
 * email composer, email macros, and the signature editor. Value in/out is HTML;
 * legacy plain-text values (markdown links + newlines) are upconverted on load.
 * Inline images upload to comm-media (10-year signed URLs — same durability
 * rule as MMS) so they render for the recipient and in old timelines alike.
 * No window.prompt/alert anywhere — the companion's WKWebView no-ops them, so
 * links use an inline popover and errors render inline.
 */
export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 96,
  showPlaceholders = false,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  showPlaceholders?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");

  // Write external value changes (macro applied, initial load) into the DOM;
  // skip our own emissions so the caret never jumps mid-typing.
  useEffect(() => {
    const el = ref.current;
    if (!el || value === lastEmitted.current) return;
    const html = value && !isHtml(value) ? linkifyHtml(value) : value;
    el.innerHTML = html;
    lastEmitted.current = value;
    setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
  }, [value]);

  // Toolbar active states (bold while the caret sits in bold text, etc.).
  useEffect(() => {
    const update = () => {
      const el = ref.current;
      const sel = window.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      try {
        setActive({
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          underline: document.queryCommandState("underline"),
          insertUnorderedList: document.queryCommandState("insertUnorderedList"),
        });
      } catch {}
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    lastEmitted.current = el.innerHTML;
    setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
    onChange(el.innerHTML);
  };

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  /** Remember the editor selection before a toolbar control steals focus. */
  const saveSel = () => {
    const sel = window.getSelection();
    savedRange.current =
      sel && sel.rangeCount > 0 && ref.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };

  /** Re-apply the remembered selection (dropdown/popover interactions drop it). */
  const restoreSel = () => {
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  const applyFontSize = (v: string) => {
    ref.current?.focus();
    restoreSel();
    document.execCommand("fontSize", false, v);
    emit();
  };

  /** Open the link popover, remembering the selection the URL applies to. */
  const openLink = () => {
    saveSel();
    setLinkText(savedRange.current && !savedRange.current.collapsed ? "" : "");
    setLinkUrl("");
    setErr(null);
    setLinkOpen(true);
  };

  const insertLink = () => {
    let url = linkUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    ref.current?.focus();
    // Restore the selection the rep had before clicking into the popover.
    restoreSel();
    if (savedRange.current && !savedRange.current.collapsed) {
      document.execCommand("createLink", false, url);
    } else {
      const label = (linkText.trim() || url).replace(/</g, "&lt;");
      document.execCommand("insertHTML", false, `<a href="${url}">${label}</a>&nbsp;`);
    }
    setLinkOpen(false);
    emit();
  };

  const uploadImage = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    setErr(null);
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("read failed"));
        fr.readAsDataURL(file);
      });
      const r = await fetch("/api/texts/upload-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: file.type, filename: file.name, dataBase64: dataUrl.split(",")[1] ?? "" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) throw new Error(d.error ?? "upload failed");
      ref.current?.focus();
      document.execCommand("insertHTML", false, `<img src="${d.url}" alt="${file.name.replace(/"/g, "")}" style="max-width:100%;border-radius:6px">`);
      emit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Image upload failed");
    } finally {
      setUploading(false);
    }
  };

  // Pasted/dropped image files upload like the toolbar button — never inline
  // base64 (would bloat the stored body past request limits).
  const onPaste = (e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      void uploadImage(img);
    }
  };

  const tbtn = (label: string, title: string, fn: () => void, opts?: { style?: React.CSSProperties; on?: boolean }) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
      style={{
        border: `1px solid ${opts?.on ? "var(--accent, #d8873b)" : "var(--border)"}`,
        background: opts?.on ? "var(--surface-3)" : "var(--surface-2, var(--bg-2))",
        color: opts?.on ? "var(--text-1)" : "var(--text-2)",
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 12.5,
        cursor: "pointer",
        lineHeight: "18px",
        ...opts?.style,
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* The global `* { margin:0; padding:0 }` reset strips list indent +
          markers — restore them (and link styling) inside the editor only. */}
      <style>{`
        .rte-body ul { list-style: disc; padding-left: 24px; margin: 4px 0; }
        .rte-body ol { list-style: decimal; padding-left: 24px; margin: 4px 0; }
        .rte-body li { margin: 2px 0; }
        .rte-body a { color: var(--accent, #4c9aff); text-decoration: underline; }
      `}</style>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4, alignItems: "center" }}>
        {tbtn("B", "Bold", () => exec("bold"), { on: active.bold, style: { fontWeight: 700 } })}
        {tbtn("I", "Italic", () => exec("italic"), { on: active.italic, style: { fontStyle: "italic" } })}
        {tbtn("U", "Underline", () => exec("underline"), { on: active.underline, style: { textDecoration: "underline" } })}
        <select
          className="vmsel"
          style={{ width: "auto", fontSize: 12, padding: "2px 6px" }}
          value=""
          title="Font size — applies to the selected text"
          onMouseDown={saveSel}
          onChange={(e) => {
            if (e.target.value) applyFontSize(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">Aa Size…</option>
          <option value="1">Tiny</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="4">Medium</option>
          <option value="5">Large</option>
          <option value="7">Huge</option>
        </select>
        {tbtn("• List", "Bullet list", () => exec("insertUnorderedList"), { on: active.insertUnorderedList })}
        {tbtn("🔗 Link", "Insert link", openLink, { on: linkOpen })}
        {tbtn(uploading ? "…" : "🖼 Image", "Insert image", () => fileRef.current?.click())}
        {tbtn("Clear", "Remove formatting from the selection", () => exec("removeFormat"))}
        {showPlaceholders && (
          <select
            className="vmsel"
            style={{ width: "auto", fontSize: 12, padding: "2px 6px", marginLeft: "auto" }}
            value=""
            onMouseDown={() => ref.current?.focus()}
            onChange={(e) => {
              if (e.target.value) exec("insertText", e.target.value);
              e.target.value = "";
            }}
          >
            <option value="">+ Placeholder…</option>
            {PLACEHOLDERS.map((p) => (
              <option key={p.token} value={p.token}>{p.label}</option>
            ))}
          </select>
        )}
      </div>
      {linkOpen && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6, padding: 8, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface-2)" }}>
          <input
            className="vmsel"
            style={{ flex: 2, minWidth: 160 }}
            placeholder="https://…"
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && insertLink()}
          />
          {(!savedRange.current || savedRange.current.collapsed) && (
            <input
              className="vmsel"
              style={{ flex: 1, minWidth: 110 }}
              placeholder="Link text"
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && insertLink()}
            />
          )}
          <button type="button" className="btn primary" style={{ padding: "4px 12px", fontSize: 13 }} onClick={insertLink} disabled={!linkUrl.trim()}>
            Insert
          </button>
          <button type="button" className="btn ghost" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => setLinkOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      <div style={{ position: "relative" }}>
        {empty && placeholder && (
          <div style={{ position: "absolute", top: 8, left: 10, fontSize: 13.5, color: "var(--text-3)", pointerEvents: "none" }}>
            {placeholder}
          </div>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          className="vmsel rte-body"
          onInput={emit}
          onBlur={emit}
          onPaste={onPaste}
          style={{ minHeight, height: "auto", overflowY: "auto", maxHeight: 360, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        />
      </div>
      {err && <div style={{ color: "var(--crit)", fontSize: 12.5, marginTop: 4 }}>{err}</div>}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadImage(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** True if editor HTML has no visible content (empty paragraphs/brs only). */
export function isEmptyHtml(html: string): boolean {
  return !html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim() && !/<img\b/i.test(html);
}
