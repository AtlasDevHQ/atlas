// Client-side resolution of an ORG-scoped dashboard share (#4718). The
// resolution machinery (credentialed browser fetch against the client-resolved
// API base, WebCrypto token fingerprint, never-rejects contract) lives in
// `../../org-share-client.ts`, shared with the conversation surface (#4719);
// this module binds it to the dashboard's public API path and response mapper.
//
// This module must stay importable from client components — no `next/headers`,
// no `node:crypto`.

import { resolveOrgShare } from "../../org-share-client";
import { mapSharedDashboardResponse } from "./share-result";
import type { FetchResult } from "./share-result";

export { hashShareTokenClient } from "../../org-share-client";

/**
 * Re-resolve an org-scoped dashboard share from the browser with the viewer's
 * real credentials. The response mapping is `mapSharedDashboardResponse`, the
 * exact function the SSR path uses, so both paths return identical
 * {@link FetchResult}s for identical API responses. NEVER rejects — which is
 * what lets `OrgShareResolver` model resolution as just "in flight | FetchResult".
 */
export async function resolveOrgShareClient(token: string): Promise<FetchResult> {
  return resolveOrgShare({
    token,
    publicPath: "/api/public/dashboards",
    logLabel: "[shared-dashboard/client]",
    map: mapSharedDashboardResponse,
  });
}
