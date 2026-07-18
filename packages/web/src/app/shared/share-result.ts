// Universal (server + client) response→result mapping shared by every public
// share surface (/shared/dashboard/[token] and /shared/[token] + their embeds).
// Extracted from the dashboard's `share-result.ts` (#4718) when the shared
// CONVERSATION surface adopted the same hardened pattern (#4719), so the status
// mapping, the #4690 auth-reason split, and the #4317 token-hash logging
// discipline exist exactly ONCE — the surfaces cannot drift. Resource-specific
// body validation is injected per surface (`validate`); everything else is
// identical by construction.
//
// This module must stay importable from client components: no server-only
// imports (`next/headers`, `node:crypto`) may ever land here.

/** One of the share-fetch failure reasons — the discriminant the page and
 *  embed error shells switch on. Both surfaces derive it from this single
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

/** Result of a public share fetch, generic over the surface's success DTO. */
export type ShareFetchResult<T> = { ok: true; data: T } | { ok: false; reason: FailReason };

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
 * Per-surface validation of a share fetch's 200 body. On failure, `detail` is a
 * log-safe summary (issue paths/codes only — NEVER response values, which are
 * the shared resource's data).
 */
export type ShareBodyValidation<T> = { ok: true; data: T } | { ok: false; detail: string };

/**
 * Map a public share API response to a {@link ShareFetchResult}. Shared verbatim
 * by each surface's SSR fetch AND its client-side org-share resolution, so the
 * SSR and client paths can never drift.
 *
 * `tokenHash` is the caller's pre-computed share-token fingerprint — log lines
 * here carry it, NEVER the cleartext token (#4317). It is passed in (rather
 * than computed here) because the server and client hash via different crypto
 * APIs (`node:crypto` vs WebCrypto), and this module may import neither.
 *
 * TOTAL over its inputs: every branch — including a success response whose
 * body isn't JSON — resolves to a {@link ShareFetchResult}, never a rejection.
 * `OrgShareResolver`'s two-state model relies on that; callers still keep
 * their own try/catch for the `fetch()` call itself.
 */
export async function mapSharedResponse<T>(
  res: Response,
  tokenHash: string,
  logLabel: string,
  validate: (raw: unknown) => ShareBodyValidation<T>,
): Promise<ShareFetchResult<T>> {
  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: "not-found" };
    if (res.status === 410) return { ok: false, reason: "expired" };
    // The org-share auth wall. The API returns 403 for BOTH the no-session and
    // the wrong-org viewer, distinguished only by the response body's `error`
    // code — NOT by the status. So a 403 alone can't tell them apart; we read
    // the body. (A future 401 is also honored, so this stays correct if the
    // API ever adopts stricter HTTP semantics.) See #4690.
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
  const validated = validate(raw);
  if (!validated.ok) {
    // `detail` is log-safe by the ShareBodyValidation contract — issue
    // paths/codes only, never the response's values.
    console.error(
      `${logLabel} Unexpected response shape for tokenHash=${tokenHash}: ${validated.detail}`,
    );
    return { ok: false, reason: "server-error" };
  }
  return { ok: true, data: validated.data };
}
