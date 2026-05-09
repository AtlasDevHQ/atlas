/**
 * Hosted-MCP per-OAuth-client rate-limit middleware (#2071).
 *
 * Sits between every MCP tool dispatch and the underlying tool. The
 * pure limiter ({@link checkClientRateLimit} in `oauth-client.ts`) does
 * not touch the DB or the audit log; this module wires those edges:
 *
 *   1. Resolve the admin override from `oauth_client_rate_limits`,
 *      caching the value into the limiter's in-memory map so the
 *      hot path stays sync.
 *   2. Run the synchronous bucket check + record.
 *   3. On denial, emit the `mcp_session.rate_limited` audit row and
 *      build the structured `AtlasMcpToolError` envelope (#2030) with
 *      `code: "rate_limited"`, `retry_after`, and `hint`.
 *
 * Stdio MCP (`bin/serve.ts`, no OAuth flow) does not produce a
 * `clientId` and is exempt — the limiter is hosted-only by design.
 *
 * The exposed `enforceClientRateLimit()` returns a discriminated
 * outcome so the caller branches on `denied` without exception
 * handling.
 */

import type { AtlasMcpToolError } from "@useatlas/types/mcp";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  isInternalCircuitOpen,
} from "@atlas/api/lib/db/internal";
import {
  rateLimitAuditDropped,
  rateLimitLoaderFailures,
} from "@atlas/api/lib/metrics";
import {
  checkClientRateLimit,
  resolveRateLimitFor,
  DEFAULT_REQUESTS_PER_MINUTE,
  toolWeight,
  type RateLimitDenialReason,
  type RateLimitLoader,
} from "./oauth-client";

/**
 * Tagged error thrown by `defaultLoader` when the override-DB query
 * fails AND `ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED=true`. The middleware
 * catches this specific error and synthesizes a fail-closed denied
 * outcome so the caller sees the override-degradation hint instead of
 * the workspace default. A regular `Error` here would be ambiguous with
 * unrelated failures bubbling up from the loader.
 *
 * `_tag` is a structural discriminant so a future migration to Effect's
 * `Data.TaggedError` can match on `_tag === "RateLimitLoaderFailedError"`
 * without changing the catch site. The native ES2022 `cause` chain via
 * `super(msg, { cause })` preserves the underlying stack so pino's
 * default error serializer surfaces the original Postgres trace, not
 * just its message string.
 */
export class RateLimitLoaderFailedError extends Error {
  readonly _tag = "RateLimitLoaderFailedError" as const;
  override readonly cause: Error;
  constructor(cause: unknown) {
    const causeErr = cause instanceof Error ? cause : new Error(String(cause));
    super(`rate-limit loader failed: ${causeErr.message}`, { cause: causeErr });
    this.name = "RateLimitLoaderFailedError";
    this.cause = causeErr;
  }
}

/**
 * Retry-after value for fail-closed loader denials. 30s aligns with
 * the recovery floor of the internal-DB circuit breaker (probes run
 * 30s → 60s → 120s → 240s → 300s with exponential backoff; see
 * `lib/db/internal.ts`). Agents that politely back off for the floor
 * observe at most one fail-closed reply per probe attempt at the
 * fastest end of the schedule. Whole-second value safe to drop into
 * `Retry-After`.
 */
const LOADER_FAIL_CLOSED_RETRY_AFTER_SEC = 30;

const log = createLogger("mcp-rate-limit");

export interface EnforceClientRateLimitInput {
  readonly orgId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly toolName: string;
}

export type EnforceClientRateLimitOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "denied";
      readonly retryAfterSec: number;
      readonly limit: number;
      readonly weight: number;
      readonly envelope: AtlasMcpToolError;
    };

/**
 * Check the per-(orgId, clientId) bucket, charge `toolWeight(toolName)`
 * units on success, and emit the audit row + envelope on denial.
 *
 * The function is async only because the first check for a given
 * (orgId, clientId) loads the admin override from Postgres. Subsequent
 * checks for the same pair short-circuit through the in-memory cache.
 *
 * `loader` defaults to a Postgres lookup; tests pass a stub.
 */
export async function enforceClientRateLimit(
  input: EnforceClientRateLimitInput,
  loader: RateLimitLoader = defaultLoader,
): Promise<EnforceClientRateLimitOutcome> {
  // Prime the limit cache for this (orgId, clientId). The limiter
  // intentionally exposes this as a separate step so the hot path stays
  // synchronous — multiple tool dispatches in one MCP session pay the
  // DB roundtrip exactly once.
  try {
    await resolveRateLimitFor(input.orgId, input.clientId, loader);
  } catch (err: unknown) {
    if (err instanceof RateLimitLoaderFailedError) {
      // Fail-closed mode: the loader propagated a DB outage instead of
      // falling back to the default. Synthesize a denied outcome with
      // the override-degraded hint so the caller never reaches the
      // bucket logic — a hardened threat model explicitly prefers
      // temporary unavailability over serving an attacker the default
      // quota when the override surface is down.
      return buildLoaderFailedOutcome(input, err);
    }
    // Anything else is unexpected (programming bug in the limiter,
    // panic in a custom loader, etc.). The denial path emits rich
    // forensic context; the unexpected-failure path must do the same
    // before re-throwing so the upstream `runHandler` / `classifyError`
    // log line carries the (orgId, clientId, tool) tuple instead of a
    // bare stack trace.
    log.error(
      {
        err,
        orgId: input.orgId,
        clientId: input.clientId,
        tool: input.toolName,
      },
      "rate_limit middleware unexpected error — propagating",
    );
    throw err;
  }

  const verdict = checkClientRateLimit({
    orgId: input.orgId,
    clientId: input.clientId,
    userId: input.userId,
    toolName: input.toolName,
  });

  if (verdict.allowed) return { kind: "ok" };

  // Always emit the audit row on the denial branch — the row IS the
  // forensic signal, regardless of how the envelope is later consumed
  // (transport drop, agent retry, agent ignore-and-shift-tool).
  emitRateLimitAudit({
    clientId: input.clientId,
    userId: input.userId,
    orgId: input.orgId,
    toolName: input.toolName,
    limit: verdict.limit,
    weight: verdict.weight,
    retryAfterSec: verdict.retryAfterSec,
    remaining: verdict.remaining,
    reason: "bucket_overflow",
  });

  const envelope: AtlasMcpToolError = {
    code: "rate_limited",
    message: rateLimitedMessage(input.clientId, verdict.limit),
    hint: rateLimitedHint(verdict.retryAfterSec),
    retry_after: verdict.retryAfterSec,
  };

  return {
    kind: "denied",
    retryAfterSec: verdict.retryAfterSec,
    limit: verdict.limit,
    weight: verdict.weight,
    envelope,
  };
}

// ── Fail-closed loader-failure path ────────────────────────────────

/**
 * Strict-equals `"true"` (not truthy-coercion). Operators must opt in
 * with the documented exact value — accepting `"1"` / `"yes"` / `"TRUE"`
 * would let a typo flip the disposition, which is exactly the failure
 * mode the env var exists to prevent. A future "let's accept truthy
 * values" refactor would silently widen which configs serve fail-closed.
 */
function isFailClosedMode(): boolean {
  return process.env.ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED === "true";
}

function buildLoaderFailedOutcome(
  input: EnforceClientRateLimitInput,
  err: RateLimitLoaderFailedError,
): EnforceClientRateLimitOutcome {
  // The fail-closed path short-circuits before the bucket check, so
  // we do NOT debit the request's weight against the bucket. The
  // denial is fundamentally about override-loader unavailability, not
  // budget exhaustion — debiting would slow down recovery once the
  // loader is back. `remaining: 0` reflects the deny verdict for
  // dashboards, not actual bucket state.
  const limit = DEFAULT_REQUESTS_PER_MINUTE;
  const weight = toolWeight(input.toolName);
  const retryAfterSec = LOADER_FAIL_CLOSED_RETRY_AFTER_SEC;

  rateLimitLoaderFailures.add(1, {
    disposition: "fail_closed",
    "deploy.mode": process.env.ATLAS_DEPLOY_MODE ?? "self-hosted",
  });
  // Log the full cause object — pino's default `err` serializer expands
  // the stack and any nested cause chain, which is the actual forensic
  // signal during an override-DB outage. Logging only `.message` would
  // drop the stack and break post-incident triage.
  log.error(
    {
      err: err.cause,
      orgId: input.orgId,
      clientId: input.clientId,
      tool: input.toolName,
    },
    "rate_limit fail-closed denial — override loader degraded; serving 429",
  );

  emitRateLimitAudit({
    clientId: input.clientId,
    userId: input.userId,
    orgId: input.orgId,
    toolName: input.toolName,
    limit,
    weight,
    retryAfterSec,
    remaining: 0,
    reason: "loader_failure",
  });

  const envelope: AtlasMcpToolError = {
    code: "rate_limited",
    message: rateLimitedMessage(input.clientId, limit),
    hint: "override service degraded; retry shortly",
    retry_after: retryAfterSec,
  };

  return {
    kind: "denied",
    retryAfterSec,
    limit,
    weight,
    envelope,
  };
}

// ── Default DB-backed loader ───────────────────────────────────────

const SELECT_OVERRIDE_SQL = `
  SELECT requests_per_minute
    FROM oauth_client_rate_limits
   WHERE client_id = $1
     AND reference_id = $2
   LIMIT 1
`;

async function defaultLoader(
  orgId: string,
  clientId: string,
): Promise<number | null> {
  // Pre-DB-init bootstrap (or self-hosted without a DATABASE_URL): no
  // override surface to query — fall through to the static default.
  if (!hasInternalDB()) return null;
  try {
    const rows = await internalQuery<{ requests_per_minute: number | string }>(
      SELECT_OVERRIDE_SQL,
      [clientId, orgId],
    );
    if (rows.length === 0) return null;
    const raw = rows[0].requests_per_minute;
    const parsed =
      typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    return parsed;
  } catch (err) {
    // Loader failure must not fail-open or fail-closed silently. The
    // disposition is governed by `ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED`
    // (`ATLAS_MCP_RATE_LIMIT_FAIL_CLOSED`): fail-open is the legacy default — log a warning
    // and serve the workspace default while the override surface is
    // degraded. Fail-closed throws a tagged error the middleware
    // translates into a 429 with the override-degraded hint, so a
    // hardened threat model never serves the default quota during a
    // Postgres outage.
    if (isFailClosedMode()) {
      throw new RateLimitLoaderFailedError(err);
    }
    rateLimitLoaderFailures.add(1, {
      disposition: "fail_open",
      "deploy.mode": process.env.ATLAS_DEPLOY_MODE ?? "self-hosted",
    });
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        orgId,
        clientId,
      },
      "oauth_client_rate_limits lookup failed — using default quota",
    );
    return null;
  }
}

// ── Audit + envelope shaping ───────────────────────────────────────

interface RateLimitAuditMetadata {
  readonly clientId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly toolName: string;
  readonly limit: number;
  readonly weight: number;
  readonly retryAfterSec: number;
  readonly remaining: number;
  /** Forensic pivot dimension. Required so the caller is forced to
   *  decide between bucket-overflow and loader-failure at the call
   *  site, rather than relying on an emitter-side default that could
   *  silently mis-tag a future denial path. */
  readonly reason: RateLimitDenialReason;
}

function emitRateLimitAudit(meta: RateLimitAuditMetadata): void {
  // Security-control visibility: the audit row IS the
  // forensic signal for a rate-limit denial. When the internal-DB
  // fire-and-forget circuit breaker is open, `logAdminAction` writes
  // the pino line but the DB row is dropped. Without the explicit
  // `log.error` + counter here, an operator scanning the audit table
  // for `mcp_session.rate_limited` rows during an outage window would
  // see a misleading dip in denials. Differentiating the log line
  // (different message string, error level) lets the log stream pivot
  // pick up the dropped rows separately from successful audits.
  if (hasInternalDB() && isInternalCircuitOpen()) {
    rateLimitAuditDropped.add(1, {
      reason: "circuit_open",
      "client.id": meta.clientId,
      "tool.name": meta.toolName,
      "deploy.mode": process.env.ATLAS_DEPLOY_MODE ?? "self-hosted",
    });
    log.error(
      {
        clientId: meta.clientId,
        userId: meta.userId,
        tool: meta.toolName,
        limit: meta.limit,
        retryAfterSec: meta.retryAfterSec,
        reason: "circuit_open",
      },
      "rate_limit audit row dropped — internal DB circuit breaker open; pino line is the only trail",
    );
  }
  logAdminAction({
    actionType: ADMIN_ACTIONS.mcp_session.rateLimited,
    targetType: "mcp_session",
    targetId: meta.clientId,
    metadata: {
      clientId: meta.clientId,
      userId: meta.userId,
      tool: meta.toolName,
      reason: meta.reason,
      ratelimitState: {
        limit: meta.limit,
        weight: meta.weight,
        retryAfterSec: meta.retryAfterSec,
        remaining: meta.remaining,
      },
    },
  });
}

function rateLimitedMessage(clientId: string, limit: number): string {
  return `OAuth client "${clientId}" exceeded its hosted-MCP quota (${limit} weighted requests/min).`;
}

function rateLimitedHint(retryAfterSec: number): string {
  return `Wait ${retryAfterSec}s before retrying. The admin can raise this client's quota in Settings → OAuth Clients.`;
}

