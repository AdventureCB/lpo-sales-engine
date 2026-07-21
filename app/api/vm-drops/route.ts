import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "vm-drops";

/** List the current user's voicemail drops with short-lived playback URLs. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const folder = user.repId ?? user.authUserId;

  const db = supabaseAdmin();
  const { data: files, error } = await db.storage.from(BUCKET).list(folder, {
    sortBy: { column: "created_at", order: "desc" },
  });
  if (error) {
    console.error("vm list failed", error);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }

  const drops = [];
  for (const f of files ?? []) {
    const { data: signed } = await db.storage
      .from(BUCKET)
      .createSignedUrl(`${folder}/${f.name}`, 3600);
    drops.push({
      name: f.name.replace(/\.wav$/, ""),
      path: `${folder}/${f.name}`,
      url: signed?.signedUrl ?? null,
      createdAt: f.created_at,
    });
  }
  return NextResponse.json({ drops });
}

/** Upload a new drop (WAV body, name in query). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name || !/^[\w\- ]{1,60}$/.test(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const folder = user.repId ?? user.authUserId;
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > 10_000_000) {
    return NextResponse.json({ error: "invalid size" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { error } = await db.storage
    .from(BUCKET)
    .upload(`${folder}/${name}.wav`, bytes, { contentType: "audio/wav", upsert: true });
  if (error) {
    console.error("vm upload failed", error);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** Rename a drop (own folder only). */
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { path?: string; newName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const folder = user.repId ?? user.authUserId;
  const newName = (body.newName ?? "").trim();
  if (!body.path?.startsWith(`${folder}/`)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!/^[\w\- ]{1,60}$/.test(newName)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const { error } = await db.storage.from(BUCKET).move(body.path, `${folder}/${newName}.wav`);
  if (error) {
    console.error("vm rename failed", error);
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** Delete a drop by path (own folder only). */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const folder = user.repId ?? user.authUserId;
  if (!path.startsWith(`${folder}/`)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const db = supabaseAdmin();
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) return NextResponse.json({ error: "storage error" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
