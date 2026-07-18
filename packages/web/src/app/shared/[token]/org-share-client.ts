// Client-side resolution of an ORG-scoped conversation share (#4719) — the
// conversation surface's binding of the shared resolution machinery in
// `../org-share-client.ts` (credentialed browser fetch against the
// client-resolved API base, WebCrypto token fingerprint, never-rejects
// contract), adopted from the dashboard surface (#4718).
//
// This module must stay importable from client components — no `next/headers`,
// no `node:crypto`.

import { resolveOrgShare } from "../org-share-client";
import { mapSharedConversationResponse } from "./share-result";
import type { ConversationFetchResult } from "./share-result";

export { hashShareTokenClient } from "../org-share-client";

/**
 * Re-resolve an org-scoped conversation share from the browser with the
 * viewer's real credentials. The response mapping is
 * `mapSharedConversationResponse`, the exact function the SSR path uses, so
 * both paths return identical {@link ConversationFetchResult}s for identical
 * API responses. NEVER rejects — which is what lets `OrgShareResolver` model
 * resolution as just "in flight | result".
 */
export async function resolveOrgShareClient(
  token: string,
): Promise<ConversationFetchResult> {
  return resolveOrgShare({
    token,
    publicPath: "/api/public/conversations",
    logLabel: "[shared-conversation/client]",
    map: mapSharedConversationResponse,
  });
}
