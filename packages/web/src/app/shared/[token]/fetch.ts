// Server-only data fetch for the shared conversation surface (#4719) —
// mirror of the dashboard's `dashboard/[token]/fetch.ts`. Kept in its own
// module (not in `../lib.ts`) so the header-forwarding + token-hashing logic
// is unit-testable without rendering the RSC, and so `generateMetadata` and
// the page component share a SINGLE, de-duplicated fetch per view.
//
// The response→result mapping (status codes, #4690 auth-reason split) lives in
// `share-result.ts`, shared verbatim with the client-side org-share resolution
// (`org-share-client.ts`) so the SSR and client paths can never drift. This
// module is SERVER-ONLY (`next/headers` + `node:crypto` via `../server-share`);
// client code imports the mapping/types from `share-result.ts`, never from here.

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { getApiBaseUrl } from "../lib";
import { redactShareToken } from "../share-result";
import { buildForwardHeaders, hashShareToken } from "../server-share";
import { mapSharedConversationResponse } from "./share-result";
import type { ConversationFetchResult } from "./share-result";

export { buildForwardHeaders, hashShareToken };

/** Uncached fetch. Exported for unit tests; production callers use the
 *  `cache()`-wrapped {@link fetchSharedConversation} so the fetch runs once. */
export async function fetchSharedConversationRaw(
  token: string,
): Promise<ConversationFetchResult> {
  // Header collection stays OUTSIDE the try: a throw from `cookies()`/
  // `headers()` is a request-scope programming error, not the viewer's
  // connection — surfacing it beats misreporting it as `network-error`.
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const forwardHeaders = buildForwardHeaders({
    cookie: cookieStore.toString() || null,
    forwardedFor: headerStore.get("x-forwarded-for"),
    realIp: headerStore.get("x-real-ip"),
  });

  try {
    const res = await fetch(
      `${getApiBaseUrl()}/api/public/conversations/${encodeURIComponent(token)}`,
      // No cache — a revoked or expired share link must die immediately (the
      // old `next: { revalidate: 60 }` kept serving it for up to a minute).
      // The forwarded cookie/IP are per-viewer, so a shared cache would be
      // incorrect regardless. Intra-render dedup is `cache()`'s job below.
      { cache: "no-store", headers: forwardHeaders },
    );
    return await mapSharedConversationResponse(res, hashShareToken(token));
  } catch (err) {
    console.error(
      `[shared-conversation] Failed to fetch tokenHash=${hashShareToken(token)}:`,
      // A thrown fetch can echo the request URL — token included — in its
      // message; redact it so the #4317 hash-only discipline holds here too.
      redactShareToken(err instanceof Error ? err.message : String(err), token),
    );
    return { ok: false, reason: "network-error" };
  }
}

/**
 * Fetch the shared conversation ONCE per view. `cache()` de-duplicates the
 * call across `generateMetadata` and the page render within a single request,
 * so dropping the old `revalidate: 60` doesn't reintroduce a double fetch.
 */
export const fetchSharedConversation = cache(fetchSharedConversationRaw);
