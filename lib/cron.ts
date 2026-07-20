import "server-only";
import { env } from "./env";

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. */
export function isAuthorizedCron(req: Request): boolean {
  return req.headers.get("authorization") === `Bearer ${env("CRON_SECRET")}`;
}
