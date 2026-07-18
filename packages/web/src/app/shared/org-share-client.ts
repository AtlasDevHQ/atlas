// Client-side resolution of an ORG-scoped share, generic over the surface
// (#4718; generalized for the conversation surface in #4719).
//
// Under ADR-0024 the SaaS session cookie is host-only on the per-region API
// domain — the browser never sends it to the web origin, so the RSC cookie
// forward in each surface's `fetch.ts` is structurally empty cross-origin and
// every org share hit the auth wall regardless of the viewer's real session.
// When SSR lands on that wall, the surface mounts its `OrgShareResolver`,
// which calls this module: a browser fetch with credentials (the same pattern
// the dashboard share-status fetch in
// `(workspace)/dashboards/[id]/share-dialog.tsx` uses), so the API sees the
// viewer's REAL session and the login-required / membership-required split
// (#4690) is evaluated truthfully. A client fetch is inherently per-viewer, so
// the SSR path's `x-forwarded-for` rate-limit forwarding has no analogue here.
//
// This module must stay importable from client components — no `next/headers`,
// no `node:crypto`.

import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import type { ShareFetchResult } from "./share-result";

/**
 * Browser-safe mirror of `hashShareToken` (`server-share.ts`, itself mirroring
 * the API's copy): first 16 hex of SHA-256 — async because WebCrypto is. Log
 * lines on the share surfaces carry this fingerprint, NEVER the cleartext
 * token (#4317). Returns a fixed placeholder when WebCrypto is unavailable
 * (insecure-context browsers): an unfingerprinted log line beats logging a
 * bearer credential.
 */
export async function hashShareTokenClient(token: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "unavailable(insecure-context)";
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Re-resolve an org-scoped share from the browser with the viewer's real
 * credentials. Targets the client-resolved API base (`@/lib/api-url` — the
 * regional override when an `atlas_region` signal is active, else the
 * build-time default; empty string → same-origin relative fetch on
 * self-hosted). `map` is the surface's response mapper — the EXACT function
 * its SSR path uses (built on `mapSharedResponse`), so both paths return
 * identical {@link ShareFetchResult}s for identical API responses.
 *
 * NEVER rejects — thrown fetches map to `network-error` — which is what lets
 * each `OrgShareResolver` model resolution as just "in flight | result".
 */
export async function resolveOrgShare<T>(opts: {
  token: string;
  /** Public API collection path for the surface, e.g. `/api/public/dashboards`. */
  publicPath: string;
  /** Log prefix, e.g. `[shared-dashboard/client]`. */
  logLabel: string;
  /** The surface's shared response→result mapper. */
  map: (res: Response, tokenHash: string, logLabel: string) => Promise<ShareFetchResult<T>>;
}): Promise<ShareFetchResult<T>> {
  const { token, publicPath, logLabel, map } = opts;
  // Fingerprint once, up front, so the catch below can never itself throw
  // (a rejecting `subtle.digest` in an exotic iframe context must not mask the
  // real fetch error or break the never-rejects contract).
  const tokenHash = await hashShareTokenClient(token).catch(
    // intentionally ignored: a failed fingerprint must never block resolving
    // the share; the placeholder is the documented degraded mode.
    () => "unavailable(hash-failed)",
  );
  try {
    const res = await fetch(`${getApiUrl()}${publicPath}/${encodeURIComponent(token)}`, {
      // No cache — same rationale as the SSR fetch: revoked links must die
      // immediately, and the result is per-viewer.
      cache: "no-store",
      credentials: isCrossOrigin() ? "include" : "same-origin",
    });
    return await map(res, tokenHash, logLabel);
  } catch (err) {
    console.error(
      `${logLabel} Failed to fetch tokenHash=${tokenHash}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "network-error" };
  }
}
