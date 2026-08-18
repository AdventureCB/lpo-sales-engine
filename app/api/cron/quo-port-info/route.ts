import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Port-request inventory from the Quo API: every line + its users. The
 * account number / PIN / billing identity are dashboard-only. Admin or cron. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isAuthorizedCron(req) && user?.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const res = await fetch("https://api.quo.com/v1/phone-numbers", {
    headers: { Authorization: env("QUO_API_KEY"), "User-Agent": "lpo-sales-engine/0.1" },
  });
  if (!res.ok) {
    return NextResponse.json({ error: `quo ${res.status}: ${(await res.text()).slice(0, 200)}` }, { status: 502 });
  }
  const data = (await res.json())?.data ?? [];
  return NextResponse.json({
    numbers: data.map((n: any) => ({
      number: n.number ?? n.phoneNumber ?? null,
      name: n.name ?? null,
      id: n.id,
      users: (n.users ?? []).map((u: any) => u.email ?? u.name ?? u.id),
    })),
  });
}
