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
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  checkClientRateLimit,
  resolveRateLimitFor,
  type RateLimitLoader,
} from "./oauth-client";

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
  await resolveRateLimitFor(input.orgId, input.clientId, loader);

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
    // Loader failure must not fail-open or fail-closed silently. We
    // log at warn so a Postgres outage surfaces, and return null so the
    // limiter falls back to the documented default — which keeps
    // legitimate traffic served while the override surface is degraded.
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
}

function emitRateLimitAudit(meta: RateLimitAuditMetadata): void {
  logAdminAction({
    actionType: ADMIN_ACTIONS.mcp_session.rateLimited,
    targetType: "mcp_session",
    targetId: meta.clientId,
    metadata: {
      clientId: meta.clientId,
      userId: meta.userId,
      tool: meta.toolName,
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

