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
import type { SharedConversation, SharedMessage } from "../lib";

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
 * is deliberately opaque AI-SDK content) — so the envelope and each message
 * are checked field-by-field and the result is CONSTRUCTED, never cast: a
 * malformed body (e.g. `messages: [null]`) maps to the diagnosable
 * `server-error` path instead of crashing the view. `detail` carries field
 * names only, never response values (they are the conversation's data).
 */
function validateSharedConversation(raw: unknown): ShareBodyValidation<SharedConversation> {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "body is not an object" };
  const { title, surface, createdAt, messages } = raw as Record<string, unknown>;
  if (title !== null && typeof title !== "string") {
    return { ok: false, detail: "title is not a string or null" };
  }
  if (typeof surface !== "string") return { ok: false, detail: "surface is not a string" };
  if (typeof createdAt !== "string") return { ok: false, detail: "createdAt is not a string" };
  if (!Array.isArray(messages)) return { ok: false, detail: "missing messages array" };
  const parsedMessages: SharedMessage[] = [];
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") {
      return { ok: false, detail: `messages[${i}] is not an object` };
    }
    const msg = m as Record<string, unknown>;
    if (typeof msg.role !== "string") {
      return { ok: false, detail: `messages[${i}].role is not a string` };
    }
    if (typeof msg.createdAt !== "string") {
      return { ok: false, detail: `messages[${i}].createdAt is not a string` };
    }
    // `content` is deliberately opaque (`unknown`) — the views' extractors
    // tolerate any shape.
    parsedMessages.push({ role: msg.role, content: msg.content, createdAt: msg.createdAt });
  }
  return { ok: true, data: { title, surface, createdAt, messages: parsedMessages } };
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
