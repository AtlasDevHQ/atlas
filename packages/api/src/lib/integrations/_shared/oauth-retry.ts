/**
 * Shared OAuth refresh-retry harness for lazy integration plugins (#2708).
 *
 * Salesforce (#2658), Jira (#2659), and Linear (#2750) each lazy-build a
 * plugin instance that calls an upstream API with a stored OAuth access
 * token, and each needs the identical "session expired → refresh → retry
 * once → evict on permanent failure" dance. This factory is the single
 * copy of that control flow; the three builders supply only the parts
 * that genuinely differ:
 *
 *   - `isSessionExpired` — Salesforce keys off jsforce's
 *     `INVALID_SESSION_ID` message; Jira and Linear key off an HTTP 401
 *     surfaced as a typed `*UnauthorizedError`.
 *   - `refreshContext` — runs the platform's token refresh and returns
 *     the next call context: a rebuilt jsforce `Connection`, a
 *     `{ baseUrl, accessToken }` pair, or a bare access-token string.
 *   - `reconnectErrorClass` — the platform's reconnect-required error
 *     (now the shared {@link IntegrationReconnectRequiredError}). Injected
 *     rather than imported so the lazy-builder tests can drive eviction
 *     with a lightweight fake via `mock.module`. Used for the `instanceof`
 *     check that distinguishes a permanent refresh failure (evict) from a
 *     transient one (leave the cache warm).
 *
 * Context persistence: the harness owns the mutable call context. A
 * successful mid-flight refresh updates it, so a later `withRetry` call on
 * the same instance starts from the refreshed token rather than the stale
 * one — matching the per-builder closures this replaced.
 *
 * Eviction wire: on a *permanent* refresh failure (the refresh throws
 * `reconnectErrorClass`), the harness evicts THIS instance from the lazy
 * loader before re-throwing, so the next tool call rebuilds from the fresh
 * `workspace_plugins.config` (now `status: reconnect_needed`) and
 * short-circuits to the reconnect error at the status check instead of
 * looping on a stale token. A *transient* failure (plain `Error`) leaves
 * the cache warm so a flaky network doesn't force a rebuild per call.
 *
 * @see packages/api/src/lib/integrations/salesforce/lazy-builder.ts
 * @see packages/api/src/lib/integrations/jira/lazy-builder.ts
 * @see packages/api/src/lib/integrations/linear/lazy-builder.ts
 * @see packages/api/src/lib/effect/errors.ts — IntegrationReconnectRequiredError
 */

import { lazyPluginLoader } from "@atlas/api/lib/plugins/lazy-loader";
import type { createLogger } from "@atlas/api/lib/logger";

/** Logger surface the harness needs — satisfied by any `createLogger` result. */
type RetryLogger = Pick<ReturnType<typeof createLogger>, "info">;

/**
 * Minimal constructor type for the `instanceof` eviction check. Accepts
 * any error class — the shared `IntegrationReconnectRequiredError` in
 * production, or a lightweight fake injected under `mock.module`.
 */
type ReconnectErrorClass = new (...args: never[]) => object;

export interface OAuthRetryConfig<Ctx> {
  /** Tenant whose install this instance serves — log + evict key. */
  readonly workspaceId: string;
  /** Catalog id the instance is cached under — the other evict key. */
  readonly catalogId: string;
  /** Human-readable platform label for the "<X> session expired" log line. */
  readonly platformLabel: string;
  /** Per-builder logger so log lines keep their `component` tag. */
  readonly logger: RetryLogger;
  /** Initial call context (token / connection / baseUrl+token pair). */
  readonly initialContext: Ctx;
  /** True when `err` means the upstream rejected the stored access token. */
  readonly isSessionExpired: (err: unknown) => boolean;
  /**
   * Run the platform token refresh and return the next call context.
   * Receives the current context so platforms that only partially rotate
   * (Jira keeps the prior base URL when the refresh omits one) can fall
   * back. Throws `reconnectErrorClass` on permanent failure.
   */
  readonly refreshContext: (current: Ctx) => Promise<Ctx>;
  /** Reconnect-required error class for the permanent-vs-transient check. */
  readonly reconnectErrorClass: ReconnectErrorClass;
}

/** Runs `fn` against the current context, with one refresh-and-retry on session expiry. */
export type OAuthWithRetry<Ctx> = <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>;

/**
 * Build a `withRetry` runner closed over a single lazy plugin instance's
 * OAuth context. See the module docblock for the full contract.
 */
export function createOAuthRetry<Ctx>(config: OAuthRetryConfig<Ctx>): OAuthWithRetry<Ctx> {
  const {
    workspaceId,
    catalogId,
    platformLabel,
    logger,
    isSessionExpired,
    refreshContext,
    reconnectErrorClass,
  } = config;
  let context = config.initialContext;

  // Single-flight refresh. Concurrent `withRetry` calls on the same cached
  // instance can all observe the same stale `context` and would otherwise
  // each fire `refreshContext`. For platforms that rotate the refresh token
  // on every refresh (Jira, Linear), the second exchange reuses an
  // already-consumed token, fails `invalid_grant`, and bricks a healthy
  // install with a false reconnect + eviction. Gate refreshes through one
  // in-flight promise so later callers await the winner's result. The slot
  // clears once settled, so a genuinely new expiry still refreshes.
  let refreshInFlight: Promise<Ctx> | null = null;
  const refreshOnce = (current: Ctx): Promise<Ctx> => {
    refreshInFlight ??= (async () => {
      try {
        return await refreshContext(current);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };

  return async function withRetry<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    try {
      return await fn(context);
    } catch (err) {
      if (!isSessionExpired(err)) throw err;
      logger.info({ workspaceId }, `${platformLabel} session expired — refreshing token`);
      try {
        context = await refreshOnce(context);
        return await fn(context);
      } catch (refreshErr) {
        // Permanent failure (revoked grant, deleted user, scope loss) must
        // not keep the cached instance alive on a stale token — evict so
        // the next call rebuilds and short-circuits to the reconnect error
        // at the status check. A transient failure (plain Error) is left
        // alone so the cache stays warm.
        if (refreshErr instanceof reconnectErrorClass) {
          // Fire-and-forget — `evict` only logs on teardown failure; a
          // logger glitch must not mask the underlying refresh error.
          // Tagged void to silence the floating-promise check.
          void lazyPluginLoader.evict(workspaceId, catalogId);
        }
        throw refreshErr;
      }
    }
  };
}
