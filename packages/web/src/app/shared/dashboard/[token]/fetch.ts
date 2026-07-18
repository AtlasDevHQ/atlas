// Server-only data fetch for the shared dashboard surface. Kept in its own
// module (not inlined in `page.tsx`) so the header-forwarding + token-hashing
// logic is unit-testable without rendering the RSC, and so `generateMetadata`
// and the page component share a SINGLE, de-duplicated fetch per view (#4317).
//
// The response→result mapping (status codes, #4690 auth-reason split, schema
// validation) lives in `share-result.ts`, shared verbatim with the client-side
// org-share resolution (`org-share-client.ts`, #4718) so the SSR and client
// paths can never drift. The server-side concerns — viewer header forwarding
// and the `node:crypto` token hash — live in `../../server-share.ts`, shared
// with the conversation surface's fetch (#4719) and re-exported here for this
// surface's consumers/tests. This module is SERVER-ONLY (it imports
// `next/headers` via itself and `node:crypto` via `server-share`). Client code
// imports the mapping/types from `share-result.ts`, never from here.

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { getApiBaseUrl } from "../../lib";
import { buildForwardHeaders, hashShareToken } from "../../server-share";
import { mapSharedDashboardResponse } from "./share-result";
import type { FetchResult } from "./share-result";

export { buildForwardHeaders, hashShareToken };

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
      err instanceof Error ? err.message : String(err),
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
