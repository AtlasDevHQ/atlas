/**
 * Sandbox provider credential validation.
 *
 * Each function hits the real provider API to verify that the supplied
 * credentials are valid. Returns a discriminated union indicating
 * success (with display name) or failure (with error message).
 */

import net from "node:net";

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("sandbox-validate");

export type ValidationResult =
  | { valid: true; displayName: string }
  | { valid: false; error: string };

/** Timeout for provider API validation calls (10 seconds). */
const VALIDATION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// URL safety (SSRF prevention)
// ---------------------------------------------------------------------------

/**
 * CIDR blocklist of address ranges that must never be reachable from a
 * host-side fetch. Built once at module load via `node:net`'s `BlockList` —
 * which does the bit-level CIDR membership AND natively canonicalizes
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d` and the hex `::ffff:7f00:1` form) against
 * the IPv4 subnets, closing the encoding bypasses the old string-prefix guard
 * leaked (verified in #3006).
 */
const PRIVATE_RANGES: ReadonlyArray<readonly [string, number, "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"], // "this network" — also the target a bare `172.`-style garbage host normalizes into
  ["10.0.0.0", 8, "ipv4"], // RFC 1918
  ["127.0.0.0", 8, "ipv4"], // loopback
  ["169.254.0.0", 16, "ipv4"], // link-local (cloud metadata: 169.254.169.254)
  ["172.16.0.0", 12, "ipv4"], // RFC 1918
  ["192.168.0.0", 16, "ipv4"], // RFC 1918
  ["100.64.0.0", 10, "ipv4"], // CGNAT (RFC 6598)
  ["fc00::", 7, "ipv6"], // unique local address (ULA)
  ["fe80::", 10, "ipv6"], // link-local
];

const PRIVATE_BLOCKLIST: net.BlockList = (() => {
  const list = new net.BlockList();
  for (const [addr, prefix, type] of PRIVATE_RANGES) list.addSubnet(addr, prefix, type);
  list.addAddress("::1", "ipv6"); // IPv6 loopback (no dedicated prefix length)
  list.addAddress("::", "ipv6"); // unspecified address
  return list;
})();

/** Hostnames that resolve to internal infra and must be rejected by name (no DNS lookup needed). */
function isBlockedHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal")
  );
}

/**
 * Validates that a user-supplied URL is safe for server-side requests.
 * Blocks non-HTTPS schemes, internal hostnames, and any address in a
 * private / loopback / link-local / CGNAT range. Exported as the single
 * IP-parsing SSRF primitive every store-then-fetch surface routes through
 * (sub-processor webhook subscriptions, Daytona validation, and — via
 * `assertBaseUrlAllowed` — the OpenAPI probe + operation paths).
 *
 * Parses the host with the same WHATWG `URL` the runtime's `fetch` uses, so the
 * value we validate is the value the network stack connects to (no
 * parser-differential TOCTOU). IP literals are tested for CIDR membership via
 * {@link PRIVATE_BLOCKLIST}; bracketed IPv6 and IPv4-mapped IPv6 are handled.
 * A hostname that is not an IP literal is NOT DNS-resolved — a public name that
 * resolves to a private IP is out of scope here (a redirect to such a host is
 * caught at fetch time by `guardedFetch`). Anything that fails to parse, uses a
 * disallowed scheme, or lands in a blocked range fails CLOSED (`false`).
 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // intentionally ignored: an unparseable URL is not safe — fail closed.
    return false;
  }
  if (parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return false;
  if (isBlockedHostname(host)) return false;

  // WHATWG brackets IPv6 hosts (`[::1]`); strip them before parsing.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (net.isIPv4(bare)) return !PRIVATE_BLOCKLIST.check(bare, "ipv4");
  // `check(_, "ipv6")` covers pure IPv6 ranges AND IPv4-mapped addresses, which
  // BlockList canonicalizes back to IPv4 and tests against the IPv4 subnets.
  if (net.isIPv6(bare)) return !PRIVATE_BLOCKLIST.check(bare, "ipv6");

  // Not an IP literal — a DNS name we deliberately do not resolve.
  return true;
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

export async function validateVercelCredentials(
  accessToken: string,
  teamId: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: "Invalid access token — check your Vercel token permissions" };
      }
      if (status === 404) {
        return { valid: false, error: "Team not found — verify your Team ID" };
      }
      return { valid: false, error: `Vercel API returned ${status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { name?: string };
    return { valid: true, displayName: data.name ?? teamId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Vercel credential validation failed");
    return { valid: false, error: `Could not reach Vercel API: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// E2B
// ---------------------------------------------------------------------------

export async function validateE2BCredentials(
  apiKey: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.e2b.dev/sandboxes", {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: "Invalid API key — check your E2B API key" };
      }
      return { valid: false, error: `E2B API returned ${status}` };
    }
    return { valid: true, displayName: "E2B" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "E2B credential validation failed");
    return { valid: false, error: `Could not reach E2B API: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Daytona
// ---------------------------------------------------------------------------

export async function validateDaytonaCredentials(
  apiKey: string,
  apiUrl?: string,
): Promise<ValidationResult> {
  const base = apiUrl ?? "https://api.daytona.io";

  // Validate user-supplied URL to prevent SSRF
  if (apiUrl && !isSafeExternalUrl(apiUrl)) {
    return { valid: false, error: "API URL must use HTTPS and point to a public hostname" };
  }

  try {
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        return { valid: false, error: "Invalid API key — check your Daytona API key" };
      }
      return { valid: false, error: `Daytona API returned ${status}` };
    }
    return { valid: true, displayName: apiUrl ? `Daytona (${apiUrl})` : "Daytona Cloud" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "Daytona credential validation failed");
    return { valid: false, error: `Could not reach Daytona API: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function validateCredentials(
  provider: string,
  credentials: Record<string, unknown>,
): Promise<ValidationResult> {
  switch (provider) {
    case "vercel": {
      const accessToken = credentials.accessToken;
      const teamId = credentials.teamId;
      if (typeof accessToken !== "string" || !accessToken) {
        return { valid: false, error: "Access token is required" };
      }
      if (typeof teamId !== "string" || !teamId) {
        return { valid: false, error: "Team ID is required" };
      }
      return validateVercelCredentials(accessToken, teamId);
    }
    case "e2b": {
      const apiKey = credentials.apiKey;
      if (typeof apiKey !== "string" || !apiKey) {
        return { valid: false, error: "API key is required" };
      }
      return validateE2BCredentials(apiKey);
    }
    case "daytona": {
      const apiKey = credentials.apiKey;
      if (typeof apiKey !== "string" || !apiKey) {
        return { valid: false, error: "API key is required" };
      }
      const apiUrl = typeof credentials.apiUrl === "string" ? credentials.apiUrl : undefined;
      return validateDaytonaCredentials(apiKey, apiUrl);
    }
    default:
      return { valid: false, error: `Unknown sandbox provider: ${provider}` };
  }
}
