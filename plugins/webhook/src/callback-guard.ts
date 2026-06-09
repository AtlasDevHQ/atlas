/**
 * Callback URL SSRF guard (#3347).
 *
 * The async-delivery `callbackUrl` can be supplied per-request in the signed
 * body, making it a request-body-controlled fetch target. The old guard was a
 * string-prefix denylist (only the literal `169.254.169.254`, no IPv6/ULA/
 * CGNAT coverage, no DNS resolution). This module mirrors the posture of the
 * canonical `isSafeExternalUrl` / `guardedFetch` in `@atlas/api` (which this
 * standalone plugin cannot import — it depends only on the plugin SDK):
 *
 *   - HTTPS-only by default (TLS cert validation also defeats classic DNS
 *     rebinding: an attacker's hostname re-pointed at an internal service
 *     fails the handshake unless that service holds the attacker's cert).
 *   - IP literals checked against the full private/loopback/link-local/CGNAT
 *     ranges via `net.BlockList` (canonicalizes IPv4-mapped IPv6 and the
 *     decimal/octal IPv4 forms the WHATWG URL parser normalizes).
 *   - Non-literal hostnames are DNS-resolved and EVERY resolved address must
 *     be public (closes "public name resolving to an internal IP").
 *   - Redirects are never followed on delivery (`redirect: "manual"`), so a
 *     public callback 302-ing to metadata cannot be chased.
 *
 * Operator opt-out for self-hosted internal callbacks:
 * `ATLAS_WEBHOOK_ALLOW_INTERNAL_CALLBACKS=true` (http allowed, range checks
 * skipped — deliberate, auditable escape hatch).
 */

import net from "node:net";
import dns from "node:dns/promises";

const PRIVATE_RANGES: ReadonlyArray<readonly [string, number, "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"], // "this network"
  ["10.0.0.0", 8, "ipv4"], // RFC 1918
  ["127.0.0.0", 8, "ipv4"], // loopback
  ["169.254.0.0", 16, "ipv4"], // link-local (cloud metadata)
  ["172.16.0.0", 12, "ipv4"], // RFC 1918
  ["192.168.0.0", 16, "ipv4"], // RFC 1918
  ["100.64.0.0", 10, "ipv4"], // CGNAT (RFC 6598)
  ["fc00::", 7, "ipv6"], // unique local address (ULA)
  ["fe80::", 10, "ipv6"], // link-local
];

const PRIVATE_BLOCKLIST: net.BlockList = (() => {
  const list = new net.BlockList();
  for (const [addr, prefix, type] of PRIVATE_RANGES) list.addSubnet(addr, prefix, type);
  list.addAddress("::1", "ipv6");
  list.addAddress("::", "ipv6");
  return list;
})();

function isBlockedHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal")
  );
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return PRIVATE_BLOCKLIST.check(address, "ipv4");
  if (net.isIPv6(address)) {
    // `check(_, "ipv6")` also canonicalizes IPv4-mapped (`::ffff:a.b.c.d`)
    // addresses against the IPv4 subnets.
    return PRIVATE_BLOCKLIST.check(address, "ipv6");
  }
  // Not an IP literal at all — treat as private (fail closed); callers only
  // pass values that came from `URL.hostname` or a DNS answer.
  return true;
}

/** Whether the operator opted out of the callback egress guard. */
export function isInternalCallbackAllowed(): boolean {
  return process.env.ATLAS_WEBHOOK_ALLOW_INTERNAL_CALLBACKS === "true";
}

/** DNS resolver seam — tests inject a stub so hermetic hostnames work offline. */
export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

const defaultResolve: ResolveHostAddresses = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export type CallbackUrlVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a callback URL against the SSRF guard. Resolves non-literal
 * hostnames and requires every resolved address to be public. Fails CLOSED
 * on parse errors, blocked ranges, and DNS resolution failures.
 */
export async function validateCallbackUrl(
  url: string,
  resolve: ResolveHostAddresses = defaultResolve,
): Promise<CallbackUrlVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // intentionally ignored: an unparseable URL is not safe — fail closed.
    return { ok: false, reason: "Callback URL is not a valid URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Callback URL must use http(s)" };
  }

  if (isInternalCallbackAllowed()) return { ok: true };

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason:
        "Callback URL must use HTTPS (set ATLAS_WEBHOOK_ALLOW_INTERNAL_CALLBACKS=true for internal/dev targets)",
    };
  }

  // Normalize FQDN trailing dots so the hostname denylist can't be bypassed.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) return { ok: false, reason: "Callback URL has an empty host" };
  if (isBlockedHostname(host)) {
    return { ok: false, reason: "Callback URL targets an internal hostname" };
  }

  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (net.isIPv4(bare) || net.isIPv6(bare)) {
    return isPrivateAddress(bare)
      ? { ok: false, reason: "Callback URL targets a private/internal address" }
      : { ok: true };
  }

  // DNS name — resolve and require every answer to be public.
  let addresses: string[];
  try {
    addresses = await resolve(bare);
  } catch {
    // intentionally treated as blocked: an unresolvable callback host cannot
    // be validated (and could not be delivered to anyway).
    return { ok: false, reason: "Callback host could not be resolved" };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "Callback host resolved to no addresses" };
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return {
        ok: false,
        reason: "Callback host resolves to a private/internal address",
      };
    }
  }
  return { ok: true };
}

/**
 * Per-request callback override allowlist (#3347). A request-body
 * `callbackUrl` is accepted only when its host matches the channel-configured
 * callback host or one of the channel's `allowedCallbackHosts`. Without a
 * channel-level anchor there is nothing to allowlist against — the override
 * is rejected (channel-config-only callbacks).
 */
export function isOverrideHostAllowed(
  overrideUrl: string,
  channel: { callbackUrl?: string; allowedCallbackHosts?: string[] },
): boolean {
  let overrideHost: string;
  try {
    overrideHost = new URL(overrideUrl).host.toLowerCase();
  } catch {
    // intentionally ignored: unparseable URL — fail closed.
    return false;
  }

  if (channel.callbackUrl) {
    try {
      if (new URL(channel.callbackUrl).host.toLowerCase() === overrideHost) return true;
    } catch {
      // intentionally ignored: a malformed channel URL can't anchor the
      // allowlist; fall through to allowedCallbackHosts.
    }
  }

  return (channel.allowedCallbackHosts ?? []).some(
    (h) => h.toLowerCase() === overrideHost,
  );
}
