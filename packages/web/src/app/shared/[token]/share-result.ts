// Universal (server + client) response mapping for the shared-conversation
// fetch (#4719) — the conversation surface's binding of the resource-agnostic
// core in `../share-result.ts` (status mapping, #4690 auth-reason split,
// totality), shared verbatim by the SSR fetch (`fetch.ts`) and the client-side
// org-share resolution (`org-share-client.ts`) so the two paths can never
// drift. Must stay importable from client components: no server-only imports
// (`next/headers`, `node:crypto`) may ever land here.

import {
  mapSharedResponse,
  type ShareBodyValidation,
  type ShareFetchResult,
} from "../share-result";
import type { SharedConversation } from "../lib";

// The resource-agnostic reason vocabulary + auth-wall helpers, re-exported so
// this surface's consumers keep one import site.
export {
  isAuthWallReason,
  resolveAuthReason,
  type AuthWallReason,
  type FailReason,
} from "../share-result";

export type ConversationFetchResult = ShareFetchResult<SharedConversation>;

/**
 * Structural validation of the public-conversation body. Unlike the dashboard
 * surface there is no wire schema in `@useatlas/schemas` for this projection
 * (the `SharedConversation` type lives here in web, and `messages[].content`
 * is deliberately opaque AI-SDK content) — so this keeps the surface's
 * long-standing structural contract: an object carrying a `messages` array.
 * `detail` never carries response values (they are the conversation's data).
 */
function validateSharedConversation(raw: unknown): ShareBodyValidation<SharedConversation> {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { messages?: unknown }).messages)
  ) {
    return { ok: false, detail: "missing messages array" };
  }
  return { ok: true, data: raw as SharedConversation };
}

/**
 * Map a public-conversation API response to a {@link ConversationFetchResult}.
 * TOTAL over its inputs (see `mapSharedResponse`) — `OrgShareResolver`'s
 * two-state model relies on it never rejecting.
 *
 * `tokenHash` is the caller's pre-computed share-token fingerprint — log lines
 * carry it, NEVER the cleartext token (#4317).
 */
export async function mapSharedConversationResponse(
  res: Response,
  tokenHash: string,
  logLabel = "[shared-conversation]",
): Promise<ConversationFetchResult> {
  return mapSharedResponse(res, tokenHash, logLabel, validateSharedConversation);
}
