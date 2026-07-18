// Universal (server + client) response mapping for the shared-dashboard fetch.
// Extracted from `fetch.ts` (#4718) so the client-side org-share resolution
// (`org-share-client.ts`) shares the EXACT status→reason mapping and schema
// validation the SSR fetch uses — the two paths cannot drift. This module must
// stay importable from client components: no server-only imports
// (`next/headers`, `node:crypto`) may ever land here.

import { sharedDashboardViewSchema } from "@useatlas/schemas";
import type { SharedDashboard } from "./types";

/** One of the {@link FetchResult} failure reasons — the discriminant the page
 *  and embed error shells switch on. Both surfaces derive it from this single
 *  source rather than re-deriving the `Extract<…>` in each file. */
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

/** The two org-share auth-wall reasons (#4690). Single statement of the pair so
 *  {@link isAuthWallReason} and {@link resolveAuthReason} can never disagree. */
export type AuthWallReason = Extract<FailReason, "login-required" | "membership-required">;

/**
 * Whether a failure is the org-share auth wall — the branch the page hands off
 * to the client-side resolver (#4718), since under the SaaS cookie topology
 * (ADR-0024) an SSR auth-wall verdict may be a false negative for a viewer
 * whose session cookie is host-only on the API domain.
 */
export function isAuthWallReason(reason: FailReason): reason is AuthWallReason {
  return reason === "login-required" || reason === "membership-required";
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
export async function resolveAuthReason(res: Response): Promise<AuthWallReason> {
  // A 401 is unambiguously "no session" regardless of body.
  if (res.status === 401) return "login-required";
  let errorCode: string | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      errorCode = body.error;
    }
  } catch {
    // Malformed/empty body — fall through to the safe `login-required` default
    // below rather than misclassifying a no-session viewer as wrong-org.
    // intentionally ignored: absence of a parseable error code is itself the signal.
  }
  return errorCode === "forbidden" ? "membership-required" : "login-required";
}

/**
 * Map a public-dashboard API response to a {@link FetchResult}. Shared verbatim
 * by the SSR fetch (`fetch.ts`) and the client-side org-share resolution
 * (`org-share-client.ts`).
 *
 * `tokenHash` is the caller's pre-computed share-token fingerprint — log lines
 * here carry it, NEVER the cleartext token (#4317). It is passed in (rather
 * than computed here) because the server and client hash via different crypto
 * APIs (`node:crypto` vs WebCrypto), and this module may import neither.
 *
 * TOTAL over its inputs: every branch — including a success response whose
 * body isn't JSON — resolves to a {@link FetchResult}, never a rejection.
 * `OrgShareResolver`'s two-state model and any future adopter (#4719) rely on
 * that; callers still keep their own try/catch for the `fetch()` call itself.
 */
export async function mapSharedDashboardResponse(
  res: Response,
  tokenHash: string,
  logLabel = "[shared-dashboard]",
): Promise<FetchResult> {
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
    console.error(`${logLabel} API returned ${res.status} for tokenHash=${tokenHash}`);
    return { ok: false, reason: "server-error" };
  }
  // A 200 whose body isn't JSON is the API's fault, not the network's — map it
  // to server-error here rather than rejecting into the caller's catch.
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    console.error(
      `${logLabel} Non-JSON success body for tokenHash=${tokenHash}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "server-error" };
  }
  // Validate against the shared-view SSOT schema (`@useatlas/schemas`) rather
  // than trust-casting the raw JSON — the `.strict()` schema also rejects any
  // stray field the API projection might leak.
  const parsed = sharedDashboardViewSchema.safeParse(raw);
  if (!parsed.success) {
    // Log issue paths + codes only — never the response values, which are the
    // dashboard's data — so a projection drift is diagnosable from the log line.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(", ");
    console.error(
      `${logLabel} Unexpected response shape for tokenHash=${tokenHash}: ${issues}`,
    );
    return { ok: false, reason: "server-error" };
  }
  // No cast: `parsed.data` (SharedDashboardViewWire) is structurally the
  // SharedDashboard SSOT type, so any future schema/type drift fails the build
  // here rather than being papered over.
  return { ok: true, data: parsed.data };
}
