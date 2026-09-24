import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO = "AdventureCB/lpo-sales-engine";
const LATEST_PAGE = `https://github.com/${REPO}/releases/latest`;

/**
 * PUBLIC, permanent link to the newest companion installer:
 *   https://lpo-sales-engine.vercel.app/download/companion
 * Resolves the latest GitHub release (cached 5 min) and 302s to its
 * installer asset, so the link Kyle hands out never goes stale. Falls back to
 * the releases page if GitHub is unreachable or the release has no asset.
 */
export async function GET() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "lpo-sales-engine" },
      next: { revalidate: 300 },
    });
    if (r.ok) {
      const d = await r.json();
      const assets: { name: string; browser_download_url: string }[] = d.assets ?? [];
      const asset = assets.find((a) => /installer\.zip$/i.test(a.name)) ?? assets.find((a) => /\.(zip|dmg)$/i.test(a.name)) ?? assets[0];
      if (asset?.browser_download_url) return NextResponse.redirect(asset.browser_download_url, 302);
    }
  } catch {}
  return NextResponse.redirect(LATEST_PAGE, 302);
}
