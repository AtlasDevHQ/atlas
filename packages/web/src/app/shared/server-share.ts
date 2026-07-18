// SERVER-ONLY helpers shared by the public share surfaces' SSR fetches
// (dashboard `dashboard/[token]/fetch.ts`, conversation `[token]/fetch.ts`).
// Lifted out of the dashboard fetch module when the conversation surface
// adopted the same hardened pattern (#4719) so the token-hash logging
// discipline (#4317) and the viewer header forwarding exist exactly once.
// This module imports `node:crypto` and must never be imported from client
// components — the browser mirror lives in `org-share-client.ts`
// (`hashShareTokenClient`).

import { createHash } from "node:crypto";

/**
 * Short, non-reversible fingerprint of a share token for log correlation.
 * Share tokens are bearer credentials — logs on the share surfaces must carry
 * this hash, NEVER the cleartext token (#4317). Algorithm-mirror of the API's
 * `hashShareToken` (first 16 hex of SHA-256); duplicated because the web
 * package cannot import from `@atlas/api`. The API copy additionally guards
 * against non-string input — omitted here since callers always pass the
 * route's `token` string param. (`org-share-client.ts` carries the WebCrypto
 * mirror for the browser, where `node:crypto` doesn't exist.)
 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Build the headers a shared page forwards to the public share API:
 *   - `cookie`: the viewer's session so ORG-scoped shares authenticate the
 *     viewer on a SAME-ORIGIN deploy. Under the SaaS cookie topology (ADR-0024)
 *     the session cookie is host-only on the per-region API domain, so this jar
 *     is structurally empty cross-origin — the auth wall then hands off to the
 *     client-side resolver, which carries the viewer's real session (#4718).
 *   - `x-forwarded-for`: the viewer's REAL client IP so the API rate-limits per
 *     viewer, not per web-server IP (effective only when the API trusts the
 *     proxy header via `ATLAS_TRUST_PROXY`; otherwise `getClientIP` ignores it
 *     and all viewers share the anonymous ceiling — see F-73).
 * Pure + exported for unit tests. (#4317)
 */
export function buildForwardHeaders(input: {
  cookie: string | null;
  forwardedFor: string | null;
  realIp: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.cookie) out.cookie = input.cookie;
  const viewerIp = input.forwardedFor ?? input.realIp;
  if (viewerIp) out["x-forwarded-for"] = viewerIp;
  return out;
}
