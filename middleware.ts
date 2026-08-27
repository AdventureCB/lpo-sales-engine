import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Routes with their own auth: webhooks verify signatures, crons verify the
// bearer secret, health is intentionally public (booleans only).
// /api/ai has its own auth inside (admin session OR cron bearer) — the same
// pattern as crons — so it opts out of the cookie gate here.
// /api/attr/ is the anonymous first-party beacon and /attr.js is the script
// itself, loaded by anonymous store visitors — BOTH must bypass the session
// gate (the matcher only excludes _next assets, so public/ files are matched;
// /attr.js redirected to /login for two weeks and never ran for visitors).
const PUBLIC_PREFIXES = ["/login", "/api/webhooks/", "/api/cron/", "/api/health", "/api/ai/", "/api/attr/", "/attr.js", "/api/track/", "/sop.html"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    }
  );

  // The auth check runs on EVERY authenticated request — a hung Supabase
  // Auth call must never become a user-facing 504 (MIDDLEWARE_INVOCATION_
  // TIMEOUT, seen 8/27), and a slow one must not tax every page load.
  // Fail OPEN after 4s: every route re-checks the session server-side
  // (getSessionUser), so passing through without a refresh is safe — an
  // actually-unauthenticated request still 401s at the route.
  let user: unknown = null;
  try {
    const result = (await Promise.race([
      supabase.auth.getUser(),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 4000)),
    ])) as { data?: { user?: unknown } } | "timeout";
    if (result === "timeout") return res;
    user = result?.data?.user ?? null;
  } catch {
    return res; // auth service error — fail open, routes re-check
  }

  if (!user) {
    // OAuth legs (Gmail, Klaviyo) are browser navigations, not fetches —
    // send the person to login instead of a bare 401.
    if (
      pathname.startsWith("/api/") &&
      !pathname.startsWith("/api/gmail/") &&
      !pathname.startsWith("/api/klaviyo/")
    ) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
