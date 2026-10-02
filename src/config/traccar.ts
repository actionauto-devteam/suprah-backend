/*
 * Traccar integration settings. The integration is OFF unless
 * TRACCAR_INTEGRATION_ENABLED=true AND every required setting is present and
 * valid; a problem keeps it off (and is reported in System Stats) instead of
 * stopping the server. Values are never logged or returned, only the names of
 * settings that need attention.
 *
 *   TRACCAR_INTEGRATION_ENABLED    "true" to turn the integration on
 *   TRACCAR_BASE_URL               Traccar Server web/API address (https)
 *   TRACCAR_API_TOKEN              API token of Suprah's own Traccar account
 *   TRACCAR_FORWARD_SECRET         shared secret Traccar sends when forwarding
 *   TRACCAR_FORWARD_ALLOWED_IPS    address(es) Traccar Server forwards from, comma-separated;
 *                                  IPv4/IPv6 addresses or CIDR ranges (e.g. 203.0.113.7, 172.18.0.0/16)
 *   TRACCAR_DEVICE_SERVER_URL      address drivers enter in Traccar Client
 *   TRACCAR_RECONCILE_INTERVAL_MS  optional; catch-up interval (default 5 min)
 *   TRACCAR_FORWARD_MAX_PER_MINUTE optional; positions accepted per minute from those
 *                                  addresses, for the whole fleet (default 1200)
 */
import net from "net";

type Env = Record<string, string | undefined>;

export interface TraccarConfig {
  /** The switch is on. */
  enabled: boolean;
  /** On and fully configured: the integration may run. */
  usable: boolean;
  /** Names of settings that need attention (never their values). */
  problems: string[];
  baseUrl: string;
  apiToken: string;
  forwardSecret: string;
  /** Addresses and ranges forwards may come from. */
  forwardAllowedIps: string[];
  /** Forwards accepted per minute from those addresses (whole fleet). */
  forwardMaxPerMinute: number;
  deviceServerUrl: string;
  reconcileIntervalMs: number;
}

export const MIN_FORWARD_SECRET_LENGTH = 32;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
const MIN_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_FORWARD_MAX_PER_MINUTE = 1200;
const MIN_FORWARD_MAX_PER_MINUTE = 60;
const MAX_FORWARD_MAX_PER_MINUTE = 20_000;

function secureUrl(raw: string | undefined): string | null {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return value;
  } catch {
    return null;
  }
}

/** "::ffff:10.0.0.5" → "10.0.0.5" (an IPv4 client seen through an IPv6 socket). */
export function normalizeIp(ip: unknown): string {
  const value = String(ip ?? "").trim();
  return value.toLowerCase().startsWith("::ffff:") && net.isIPv4(value.slice(7)) ? value.slice(7) : value;
}

/** An address list as net.BlockList, or null when an entry isn't an address or CIDR range. */
function addressMatcher(entries: string[]): net.BlockList | null {
  const list = new net.BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
    if (!family) return null;
    if (prefix === undefined) {
      list.addAddress(address, family);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d+$/.test(prefix) || bits < 0 || bits > (family === "ipv4" ? 32 : 128)) return null;
    list.addSubnet(address, bits, family);
  }
  return list;
}

/** Whether a client address is one of the allowed addresses or ranges. */
export function ipAllowed(ip: unknown, allowed: string[]): boolean {
  const address = normalizeIp(ip);
  const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
  const matcher = allowed.length ? addressMatcher(allowed) : null;
  return Boolean(family && matcher?.check(address, family));
}

export function getTraccarConfig(env: Env = process.env): TraccarConfig {
  const enabled = String(env.TRACCAR_INTEGRATION_ENABLED ?? "").trim().toLowerCase() === "true";
  const baseUrl = secureUrl(env.TRACCAR_BASE_URL);
  const deviceServerUrl = secureUrl(env.TRACCAR_DEVICE_SERVER_URL);
  const apiToken = String(env.TRACCAR_API_TOKEN ?? "").trim();
  const forwardSecret = String(env.TRACCAR_FORWARD_SECRET ?? "").trim();
  const forwardAllowedIps = String(env.TRACCAR_FORWARD_ALLOWED_IPS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const interval = Number(env.TRACCAR_RECONCILE_INTERVAL_MS);
  const perMinute = Number(env.TRACCAR_FORWARD_MAX_PER_MINUTE);

  const problems: string[] = [];
  if (enabled) {
    if (!baseUrl) problems.push("TRACCAR_BASE_URL (missing or not https)");
    if (!apiToken) problems.push("TRACCAR_API_TOKEN (missing)");
    if (forwardSecret.length < MIN_FORWARD_SECRET_LENGTH) {
      problems.push(`TRACCAR_FORWARD_SECRET (missing or shorter than ${MIN_FORWARD_SECRET_LENGTH} characters)`);
    }
    if (forwardAllowedIps.length === 0) {
      problems.push("TRACCAR_FORWARD_ALLOWED_IPS (missing: the address Traccar Server forwards from)");
    } else if (!addressMatcher(forwardAllowedIps)) {
      problems.push("TRACCAR_FORWARD_ALLOWED_IPS (an entry isn't an IP address or CIDR range)");
    }
    if (!deviceServerUrl) problems.push("TRACCAR_DEVICE_SERVER_URL (missing or not https)");
  }

  return {
    enabled,
    usable: enabled && problems.length === 0,
    problems,
    baseUrl: baseUrl ?? "",
    apiToken,
    forwardSecret,
    forwardAllowedIps,
    forwardMaxPerMinute:
      Number.isFinite(perMinute) && perMinute >= MIN_FORWARD_MAX_PER_MINUTE
        ? Math.min(Math.round(perMinute), MAX_FORWARD_MAX_PER_MINUTE)
        : DEFAULT_FORWARD_MAX_PER_MINUTE,
    deviceServerUrl: deviceServerUrl ?? "",
    reconcileIntervalMs:
      Number.isFinite(interval) && interval >= MIN_RECONCILE_INTERVAL_MS ? interval : DEFAULT_RECONCILE_INTERVAL_MS,
  };
}
