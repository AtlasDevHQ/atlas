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

/** Expand an IPv6 literal to its eight 16-bit groups, or `null` if malformed. */
function expandIPv6Groups(ipv6: string): number[] | null {
  const halves = ipv6.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] =>
    s.length === 0 ? [] : s.split(":").map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const groups =
    halves.length === 1 ? head : [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

/**
 * Extract the IPv4 address embedded in the low 32 bits of an IPv4-compatible
 * (`::a.b.c.d`, deprecated RFC 4291) or NAT64 (`64:ff9b::a.b.c.d`, RFC 6052)
 * IPv6 literal, or `null`. The WHATWG parser canonicalizes both to compressed
 * hex (`::a9fe:a9fe`), so we expand the groups rather than scan for a dotted
 * quad. `net.BlockList` only canonicalizes the IPv4-*mapped* form (`::ffff:/96`)
 * against the IPv4 subnets — so that prefix is intentionally NOT handled here
 * (the BlockList already catches it); these two wrappers slip past it. Re-testing
 * the embedded IPv4 against the IPv4 ranges is defense-in-depth so an internal
 * IPv4 can't be smuggled through an IPv6 wrapper. Loopback/unspecified
 * (`::`, `::1`) are left to the IPv6 ranges (returned as `null`).
 */
function extractEmbeddedIPv4(ipv6: string): string | null {
  const g = expandIPv6Groups(ipv6);
  if (!g) return null;
  const highZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const isCompatible = highZero && !(g[6] === 0 && g[7] <= 1); // exclude :: and ::1
  const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (!isCompatible && !isNat64) return null;
  return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
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

  // Normalize FQDN trailing dots ("metadata.google.internal." resolves to the
  // same name) so the hostname denylist can't be bypassed with a trailing dot.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) return false;
  if (isBlockedHostname(host)) return false;

  // WHATWG brackets IPv6 hosts (`[::1]`); strip them before parsing.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (net.isIPv4(bare)) return !PRIVATE_BLOCKLIST.check(bare, "ipv4");
  if (net.isIPv6(bare)) {
    // `check(_, "ipv6")` covers pure IPv6 ranges AND IPv4-mapped addresses, which
    // BlockList canonicalizes back to IPv4 and tests against the IPv4 subnets.
    if (PRIVATE_BLOCKLIST.check(bare, "ipv6")) return false;
    // Re-test any IPv4 embedded in an IPv4-compatible / NAT64 wrapper against the
    // IPv4 ranges — BlockList does not canonicalize those (see extractEmbeddedIPv4).
    const embedded = extractEmbeddedIPv4(bare);
    if (embedded && PRIVATE_BLOCKLIST.check(embedded, "ipv4")) return false;
    return true;
  }

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
