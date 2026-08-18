import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = {
  enabled: true,
  delay_s: 25,
  greeting:
    "Hi, you've reached Lone Peak Overland. Please leave your name, number, and a quick message after the tone.",
  greeting_mode: "tts" as "tts" | "audio",
  greeting_audio_path: null as string | null,
};

async function loadConfig() {
  const { data } = await supabaseAdmin().from("crm_sync_state").select("value").eq("key", "telnyx_vm").maybeSingle();
  return { ...DEFAULTS, ...((data?.value as object) ?? {}) };
}

async function saveConfig(next: Record<string, unknown>) {
  await supabaseAdmin()
    .from("crm_sync_state")
    .upsert({ key: "telnyx_vm", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

/** Telnyx voicemail settings (greeting text/recording, ring window, on-off). Admin. */
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  const config = await loadConfig();
  // Fresh short-lived preview URL for the stored recording (path is canonical).
  let greetingAudioUrl: string | null = null;
  if (config.greeting_audio_path) {
    const { data: signed } = await supabaseAdmin()
      .storage.from("vm-drops")
      .createSignedUrl(config.greeting_audio_path, 3600);
    greetingAudioUrl = signed?.signedUrl ?? null;
  }
  return NextResponse.json({ config, greetingAudioUrl });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return NextResponse.json({ error: "admin only" }, { status: 403 });
  let body: {
    enabled?: boolean;
    delay_s?: number;
    greeting?: string;
    greeting_mode?: "tts" | "audio";
    audioBase64?: string; // new greeting recording/upload (wav or mp3)
    audioMime?: string;
    clearAudio?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const cur = await loadConfig();

  let greetingAudioPath = cur.greeting_audio_path;
  if (body.audioBase64) {
    const mime = body.audioMime === "audio/mpeg" ? "audio/mpeg" : "audio/wav";
    const buf = Buffer.from(body.audioBase64, "base64");
    if (buf.length < 1000) return NextResponse.json({ error: "recording too short" }, { status: 400 });
    if (buf.length > 10 * 1024 * 1024) return NextResponse.json({ error: "recording too large (10MB max)" }, { status: 413 });
    const path = `greeting/${crypto.randomUUID()}.${mime === "audio/mpeg" ? "mp3" : "wav"}`;
    const { error } = await db.storage.from("vm-drops").upload(path, buf, { contentType: mime });
    if (error) return NextResponse.json({ error: `upload failed: ${error.message}` }, { status: 500 });
    if (greetingAudioPath) await db.storage.from("vm-drops").remove([greetingAudioPath]).catch(() => {});
    greetingAudioPath = path;
  } else if (body.clearAudio && greetingAudioPath) {
    await db.storage.from("vm-drops").remove([greetingAudioPath]).catch(() => {});
    greetingAudioPath = null;
  }

  const next = {
    ...cur,
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(body.delay_s !== undefined ? { delay_s: Math.min(Math.max(Number(body.delay_s) || 25, 5), 45) } : {}),
    ...(body.greeting !== undefined ? { greeting: String(body.greeting).slice(0, 500) } : {}),
    ...(body.greeting_mode !== undefined ? { greeting_mode: body.greeting_mode === "audio" ? "audio" : "tts" } : {}),
    greeting_audio_path: greetingAudioPath,
  };
  // Audio mode without a recording falls back to TTS at call time — allow
  // saving, the UI flags it.
  await saveConfig(next);
  let greetingAudioUrl: string | null = null;
  if (next.greeting_audio_path) {
    const { data: signed } = await db.storage.from("vm-drops").createSignedUrl(next.greeting_audio_path, 3600);
    greetingAudioUrl = signed?.signedUrl ?? null;
  }
  return NextResponse.json({ ok: true, config: next, greetingAudioUrl });
}
