// Server-only data fetch for the shared dashboard surface. Kept in its own
// module (not inlined in `page.tsx`) so the header-forwarding + token-hashing
// logic is unit-testable without rendering the RSC, and so `generateMetadata`
// and the page component share a SINGLE, de-duplicated fetch per view (#4317).

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createHash } from "node:crypto";
import { sharedDashboardViewSchema } from "@useatlas/schemas";
import { getApiBaseUrl } from "../../lib";
import type { SharedDashboard } from "./types";

/** One of the {@link FetchResult} failure reasons — the discriminant the page
 *  and embed error shells switch on. Exported so both surfaces derive it from
 *  this single source rather than re-deriving the `Extract<…>` in each file. */
export type FailReason =
  | "not-found"
  | "expired"
  // The org-share auth wall is kept DISTINCT (not one `auth-required`): a viewer
  // with no session (`login-required`) is offered a login redirect, while a viewer
  // who is signed in but not a member of the sharing org (`membership-required`)
  // must not be dead-ended on a "Log in" CTA they've already satisfied (#4690).
  | "login-required"
  | "membership-required"
  | "server-error"
  | "network-error";

export type FetchResult = { ok: true; data: SharedDashboard } | { ok: false; reason: FailReason };

/**
 * Short, non-reversible fingerprint of a share token for log correlation.
 * Share tokens are bearer credentials — logs on this surface must carry this
 * hash, NEVER the cleartext token (#4317). Algorithm-mirror of the API's
 * `hashShareToken` (first 16 hex of SHA-256); duplicated because the web
 * package cannot import from `@atlas/api`. The API copy additionally guards
 * against non-string input — omitted here since callers always pass the
 * route's `token` string param.
 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Build the headers the shared page forwards to the public dashboard API:
 *   - `cookie`: the viewer's session so ORG-scoped shares authenticate the
 *     viewer (an unauthenticated viewer gets a 403 from the API). Without this
 *     the RSC fetch carried no cookie and `authenticateRequest` 403'd every
 *     viewer — the end-to-end break this issue fixes.
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

/**
 * Disambiguate an org-share auth failure (HTTP 401/403) into the exact reason.
 *
 * The API returns 403 for BOTH the unauthenticated viewer (`error: "auth_required"`)
 * and the authenticated-but-wrong-org viewer (`error: "forbidden"`), so the status
 * code alone is insufficient — we read the body's `error` code. Only an explicit
 * `"forbidden"` is treated as `membership-required`; every other signal (an explicit
 * `auth_required`, a 401, or a missing/malformed body) defaults to `login-required`
 * so a no-session viewer is never dead-ended without a login path (#4690). Exported
 * for unit tests.
 */
export async function resolveAuthReason(res: Response): Promise<"login-required" | "membership-required"> {
  // A 401 is unambiguously "no session" regardless of body.
  if (res.status === 401) return "login-required";
  let errorCode: string | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body) {
      const code = (body as { error?: unknown }).error;
      if (typeof code === "string") errorCode = code;
    }
  } catch {
    // Malformed/empty body — fall through to the safe `login-required` default
    // below rather than misclassifying a no-session viewer as wrong-org.
    // intentionally ignored: absence of a parseable error code is itself the signal.
  }
  return errorCode === "forbidden" ? "membership-required" : "login-required";
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
    if (!res.ok) {
      if (res.status === 404) return { ok: false, reason: "not-found" };
      if (res.status === 410) return { ok: false, reason: "expired" };
      // The org-share auth wall. The API (`dashboards.ts`) returns 403 for BOTH the
      // no-session and the wrong-org viewer, distinguished only by the response
      // body's `error` code — NOT by the status. So a 403 alone can't tell them
      // apart; we read the body. (A future 401 is also honored, so this stays
      // correct if the API ever adopts stricter HTTP semantics.) See #4690.
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: await resolveAuthReason(res) };
      }
      console.error(
        `[shared-dashboard] API returned ${res.status} for tokenHash=${hashShareToken(token)}`,
      );
      return { ok: false, reason: "server-error" };
    }
    // Validate against the shared-view SSOT schema (`@useatlas/schemas`) rather
    // than trust-casting the raw JSON — the `.strict()` schema also rejects any
    // stray field the API projection might leak.
    const parsed = sharedDashboardViewSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.error(
        `[shared-dashboard] Unexpected response shape for tokenHash=${hashShareToken(token)}`,
      );
      return { ok: false, reason: "server-error" };
    }
    // No cast: `parsed.data` (SharedDashboardViewWire) is structurally the
    // SharedDashboard SSOT type, so any future schema/type drift fails the build
    // here rather than being papered over.
    return { ok: true, data: parsed.data };
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
