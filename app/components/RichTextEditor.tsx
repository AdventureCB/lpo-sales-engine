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
  const [uploading, setUploading] = useState(false);
  const [empty, setEmpty] = useState(true);

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

  const addLink = () => {
    ref.current?.focus();
    const url = window.prompt("Link URL (https://…)");
    if (!url || !/^https?:\/\//i.test(url)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      document.execCommand("createLink", false, url);
    } else {
      const label = window.prompt("Link text", url) || url;
      document.execCommand("insertHTML", false, `<a href="${url}">${label.replace(/</g, "&lt;")}</a>&nbsp;`);
    }
    emit();
  };

  const uploadImage = async (file: File) => {
    if (uploading) return;
    setUploading(true);
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
      window.alert(e instanceof Error ? e.message : "Image upload failed");
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

  const tbtn = (label: string, title: string, fn: () => void, style?: React.CSSProperties) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
      style={{
        border: "1px solid var(--border)",
        background: "var(--bg-2)",
        color: "var(--text-2)",
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 12.5,
        cursor: "pointer",
        lineHeight: "18px",
        ...style,
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4, alignItems: "center" }}>
        {tbtn("B", "Bold", () => exec("bold"), { fontWeight: 700 })}
        {tbtn("I", "Italic", () => exec("italic"), { fontStyle: "italic" })}
        {tbtn("U", "Underline", () => exec("underline"), { textDecoration: "underline" })}
        {tbtn("•≡", "Bullet list", () => exec("insertUnorderedList"))}
        {tbtn("🔗", "Insert link", addLink)}
        {tbtn(uploading ? "…" : "🖼", "Insert image", () => fileRef.current?.click())}
        {tbtn("⌫F", "Clear formatting", () => exec("removeFormat"))}
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
          className="vmsel"
          onInput={emit}
          onBlur={emit}
          onPaste={onPaste}
          style={{ minHeight, height: "auto", overflowY: "auto", maxHeight: 360, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        />
      </div>
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
