import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "comm-media";
// Telnyx transcodes down for carriers, but keep uploads sane.
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * Ad-hoc image upload for texting (MMS). Stores in the comm-media bucket
 * under sms/ and returns a 24h signed URL — Telnyx fetches the media right
 * at send time, so the expiry is ample.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { mimeType?: string; dataBase64?: string; filename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.mimeType || !body.dataBase64) {
    return NextResponse.json({ error: "mimeType and dataBase64 required" }, { status: 400 });
  }
  if (!ALLOWED.includes(body.mimeType)) {
    return NextResponse.json({ error: "images only (jpeg/png/gif/webp)" }, { status: 415 });
  }
  const buf = Buffer.from(body.dataBase64, "base64");
  if (buf.length === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: "image too large (max 5MB)" }, { status: 413 });

  const ext = body.mimeType.split("/")[1].replace("jpeg", "jpg");
  const path = `sms/${crypto.randomUUID()}.${ext}`;
  const db = supabaseAdmin();
  const { error: upErr } = await db.storage.from(BUCKET).upload(path, buf, { contentType: body.mimeType, upsert: false });
  if (upErr) return NextResponse.json({ error: `upload failed: ${upErr.message}` }, { status: 500 });
  const { data: signed, error: sErr } = await db.storage.from(BUCKET).createSignedUrl(path, 24 * 3600);
  if (sErr || !signed?.signedUrl) return NextResponse.json({ error: "sign failed" }, { status: 500 });
  return NextResponse.json({ ok: true, url: signed.signedUrl, contentType: body.mimeType });
}
