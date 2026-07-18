// Server-only data fetch for the shared dashboard surface. Kept in its own
// module (not inlined in `page.tsx`) so the header-forwarding + token-hashing
// logic is unit-testable without rendering the RSC, and so `generateMetadata`
// and the page component share a SINGLE, de-duplicated fetch per view (#4317).
//
// The response→result mapping (status codes, #4690 auth-reason split, schema
// validation) lives in `share-result.ts`, shared verbatim with the client-side
// org-share resolution (`org-share-client.ts`, #4718) so the SSR and client
// paths can never drift. This file adds only the server-side concerns:
// `next/headers` forwarding and the `node:crypto` token hash.

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createHash } from "node:crypto";
import { getApiBaseUrl } from "../../lib";
import { mapSharedDashboardResponse } from "./share-result";
import type { FetchResult } from "./share-result";

// Historical import surface — the types + auth-reason resolver moved to
// `share-result.ts` (#4718) but remain re-exported here so existing consumers
// and tests keep importing from `./fetch`.
export { isAuthWallReason, resolveAuthReason } from "./share-result";
export type { FailReason, FetchResult } from "./share-result";

/**
 * Short, non-reversible fingerprint of a share token for log correlation.
 * Share tokens are bearer credentials — logs on this surface must carry this
 * hash, NEVER the cleartext token (#4317). Algorithm-mirror of the API's
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
 * Build the headers the shared page forwards to the public dashboard API:
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

/** Uncached fetch. Exported for unit tests; production callers use the
 *  `cache()`-wrapped {@link fetchSharedDashboard} so the fetch runs once. */
export async function fetchSharedDashboardRaw(token: string): Promise<FetchResult> {
  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    const forwardHeaders = buildForwardHeaders({
      cookie: cookieStore.toString() || null,
      forwardedFor: headerStore.get("x-forwarded-for"),
      realIp: headerStore.get("x-real-ip"),
    });

    const res = await fetch(
      `${getApiBaseUrl()}/api/public/dashboards/${encodeURIComponent(token)}`,
      // No cache — dashboard data may be sensitive and revoked links must die
      // immediately. The forwarded cookie/IP are per-viewer, so a shared cache
      // would be incorrect regardless.
      { cache: "no-store", headers: forwardHeaders },
    );
    return await mapSharedDashboardResponse(res, hashShareToken(token));
  } catch (err) {
    console.error(
      `[shared-dashboard] Failed to fetch tokenHash=${hashShareToken(token)}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "network-error" };
  }
}

/**
 * Fetch the shared dashboard ONCE per view. `cache()` de-duplicates the call
 * across `generateMetadata` and the page render within a single request, so the
 * old metadata+body double fetch is gone (#4317).
 */
export const fetchSharedDashboard = cache(fetchSharedDashboardRaw);
