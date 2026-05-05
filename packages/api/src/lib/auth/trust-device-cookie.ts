/**
 * Trust-device cookie parser.
 *
 * Better Auth sets a signed cookie named `<prefix>.trust_device` (default
 * `better-auth.trust_device`) with optional `__Secure-` prefix in production,
 * plus an env-overridable `cookiePrefix`. The cookie value format is
 * `${hmac}!${identifier}` where `identifier` is `trust-device-<random>` —
 * the same value Better Auth wrote to the `verification` table.
 *
 * We do NOT verify the HMAC here — the identifier is consumed by two read
 * paths and one audit path, none of which use it as an authorization input:
 *
 * - `/me/trusted-devices` GET: drives the "This browser" badge. The user
 *   only sees their own rows, so a forged identifier would just light up the
 *   badge on a row they already control.
 * - admin audit log: forensic metadata. A forged value would corrupt the
 *   audit row for the requesting user only — not an authorization decision.
 *
 * If a future caller wants to use this identifier as an authorization input
 * (e.g. step-up auth: "this browser cleared 2FA recently, skip the re-verify"),
 * that caller MUST verify the HMAC. Use Better Auth's
 * `getSignedCookie(c, secret, name)` directly — do not extend this helper.
 */

const TRUST_DEVICE_PREFIX = "trust-device-";
const COOKIE_SUFFIX = ".trust_device";
const SECURE_PREFIX_RE = /^__(?:Secure|Host)-/;

/**
 * Extract the trust-device identifier from a request's `Cookie` header.
 *
 * Returns null when:
 * - no cookie header is present
 * - no cookie name ends in `.trust_device`
 * - the value is malformed (no `!` separator, identifier missing the
 *   `trust-device-` prefix)
 *
 * Strategy: scan every cookie name ending in `.trust_device` (we don't know
 * the operator's `cookiePrefix` at read time and it's cheap to scan). The
 * `__Secure-` / `__Host-` prefix is stripped so prod and dev requests share
 * the same suffix logic — Better Auth's `createCookieGetter` toggles the
 * prefix dynamically based on protocol.
 */
export function extractTrustDeviceIdentifier(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const rawName = part.slice(0, eq).trim();
    const name = rawName.replace(SECURE_PREFIX_RE, "");
    if (!name.endsWith(COOKIE_SUFFIX)) continue;
    const rawValue = part.slice(eq + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // intentionally ignored: malformed encoding falls through with raw value
    }
    const bang = value.indexOf("!");
    if (bang === -1) continue;
    const identifier = value.slice(bang + 1);
    if (identifier.startsWith(TRUST_DEVICE_PREFIX)) return identifier;
  }
  return null;
}
