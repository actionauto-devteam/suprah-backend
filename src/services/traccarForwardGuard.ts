import crypto from "crypto";
import { getTraccarConfig, ipAllowed } from "../config/traccar";

/*
 * Who counts as "our Traccar Server" when it forwards positions: the forward
 * address, an allowed sender address (TRACCAR_FORWARD_ALLOWED_IPS) and the
 * shared secret, with the integration switched on. Shared by the endpoint
 * itself and by the global rate limit, which gives these requests, and only
 * these, a budget sized for the whole fleet.
 */

/** Where Traccar Server forwards positions (routes/integrations.routes.ts, under /api/integrations). */
export const TRACCAR_FORWARD_PATH = "/api/integrations/traccar/positions";

/** Constant-time check of "Authorization: Bearer <secret>". */
export function forwardSecretMatches(authorization: unknown, secret: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  if (!match || !secret) return false;
  const provided = Buffer.from(match[1].trim());
  const expected = Buffer.from(secret);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

type RequestLike = {
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  headers?: Record<string, unknown>;
};

/** A position forward from our own Traccar Server (allowed address and correct secret). */
export function isTrustedTraccarForward(req: RequestLike): boolean {
  if (String(req.method ?? "").toUpperCase() !== "POST") return false;
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0].replace(/\/+$/, "");
  if (path !== TRACCAR_FORWARD_PATH) return false;
  const config = getTraccarConfig();
  if (!config.usable) return false;
  return ipAllowed(req.ip, config.forwardAllowedIps) && forwardSecretMatches(req.headers?.authorization, config.forwardSecret);
}
