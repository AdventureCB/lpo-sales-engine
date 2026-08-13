import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "comm-media";
const MAX_BYTES = 12 * 1024 * 1024; // 12MB — keeps the base64 email under Gmail's cap

/** Upload a media asset (any user). Stores the file in the comm-media bucket
 * and records a comm_assets row whose url is the storage path. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string; filename?: string; mimeType?: string; dataBase64?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { name, filename, mimeType, dataBase64 } = body;
  if (!name?.trim() || !mimeType || !dataBase64) {
    return NextResponse.json({ error: "name, mimeType, dataBase64 required" }, { status: 400 });
  }
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: "file too large (max 12MB)" }, { status: 413 });

  const safe = (filename ?? name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const path = `media/${crypto.randomUUID()}-${safe}`;
  const db = supabaseAdmin();
  const { error: upErr } = await db.storage.from(BUCKET).upload(path, buf, { contentType: mimeType, upsert: false });
  if (upErr) return NextResponse.json({ error: `upload failed: ${upErr.message}` }, { status: 500 });

  const { data: asset, error } = await db
    .from("comm_assets")
    .insert({ kind: "media", name: name.trim(), url: path, mime_type: mimeType, owner_email: user.email })
    .select("*")
    .single();
  if (error) {
    await db.storage.from(BUCKET).remove([path]); // don't leave an orphan file
    return NextResponse.json({ error: "db error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, asset });
}
