/**
 * Shared OAuth CSRF state management.
 *
 * Stores nonces in the internal database when available (multi-instance safe).
 * Falls back to an in-memory Map for single-instance self-hosted deployments
 * without an internal database.
 *
 * Expired state is cleaned up periodically by the SchedulerLayer fiber
 * (see lib/effect/layers.ts) via {@link cleanExpiredOAuthState}.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("oauth-state");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthProvider = "slack" | "teams" | "discord";

interface MemoryState {
  orgId: string | undefined;
  provider: OAuthProvider;
  expiresAt: number;
}

export interface OAuthStateResult {
  orgId: string | undefined;
  provider: OAuthProvider;
}

// ---------------------------------------------------------------------------
// In-memory fallback (single-instance, no internal DB)
// ---------------------------------------------------------------------------

const memoryFallback = new Map<string, MemoryState>();

let _warnedFallback = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 600_000; // 10 minutes

export async function saveOAuthState(
  nonce: string,
  opts: { orgId?: string; provider: OAuthProvider; ttlMs?: number },
): Promise<void> {
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS));

  if (hasInternalDB()) {
    await internalQuery(
      `INSERT INTO oauth_state (nonce, org_id, provider, expires_at) VALUES ($1, $2, $3, $4)`,
      [nonce, opts.orgId ?? null, opts.provider, expiresAt.toISOString()],
    );
  } else {
    if (!_warnedFallback && process.env.ATLAS_DEPLOY_MODE === "saas") {
      log.warn(
        "OAuth state using in-memory fallback — DATABASE_URL is not set. " +
        "OAuth callbacks may fail in multi-instance deployments.",
      );
      _warnedFallback = true;
    }
    memoryFallback.set(nonce, {
      orgId: opts.orgId,
      provider: opts.provider,
      expiresAt: expiresAt.getTime(),
    });
  }
}

export async function consumeOAuthState(
  nonce: string,
): Promise<OAuthStateResult | null> {
  if (hasInternalDB()) {
    const rows = await internalQuery<{ org_id: string | null; provider: string }>(
      `DELETE FROM oauth_state WHERE nonce = $1 AND expires_at > now() RETURNING org_id, provider`,
      [nonce],
    );
    if (rows.length === 0) return null;
    return {
      orgId: typeof rows[0].org_id === "string" ? rows[0].org_id : undefined,
      provider: rows[0].provider as OAuthProvider,
    };
  }

  const state = memoryFallback.get(nonce);
  memoryFallback.delete(nonce);
  if (!state || Date.now() > state.expiresAt) return null;
  return { orgId: state.orgId, provider: state.provider };
}

export async function cleanExpiredOAuthState(): Promise<void> {
  if (hasInternalDB()) {
    try {
      await internalQuery(`DELETE FROM oauth_state WHERE expires_at < now()`, []);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to clean expired OAuth state",
      );
    }
  } else {
    const now = Date.now();
    for (const [nonce, state] of memoryFallback) {
      if (now > state.expiresAt) memoryFallback.delete(nonce);
    }
  }
}

/** @internal Reset in-memory state — for testing only. */
export function _resetMemoryFallback(): void {
  memoryFallback.clear();
  _warnedFallback = false;
}
