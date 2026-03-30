/**
 * Shared OAuth CSRF state management.
 *
 * Stores nonces in the internal database when available (multi-instance safe).
 * Falls back to an in-memory Map for single-instance self-hosted deployments
 * without an internal database.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("oauth-state");

// ---------------------------------------------------------------------------
// In-memory fallback (single-instance, no internal DB)
// ---------------------------------------------------------------------------

interface MemoryState {
  orgId: string | undefined;
  provider: string;
  expiresAt: number;
}

const memoryFallback = new Map<string, MemoryState>();

// Periodic sweep for the in-memory fallback (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [nonce, state] of memoryFallback) {
    if (now > state.expiresAt) memoryFallback.delete(nonce);
  }
}, 600_000).unref();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 600_000; // 10 minutes

export async function saveOAuthState(
  nonce: string,
  opts: { orgId?: string; provider: string; ttlMs?: number },
): Promise<void> {
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS));

  if (hasInternalDB()) {
    await internalQuery(
      `INSERT INTO oauth_state (nonce, org_id, provider, expires_at) VALUES ($1, $2, $3, $4)`,
      [nonce, opts.orgId ?? null, opts.provider, expiresAt.toISOString()],
    );
  } else {
    memoryFallback.set(nonce, {
      orgId: opts.orgId,
      provider: opts.provider,
      expiresAt: expiresAt.getTime(),
    });
  }
}

export async function consumeOAuthState(
  nonce: string,
): Promise<{ orgId: string | undefined } | null> {
  if (hasInternalDB()) {
    const rows = await internalQuery<Record<string, unknown>>(
      `DELETE FROM oauth_state WHERE nonce = $1 AND expires_at > now() RETURNING org_id`,
      [nonce],
    );
    if (rows.length === 0) return null;
    return {
      orgId: typeof rows[0].org_id === "string" ? rows[0].org_id : undefined,
    };
  }

  const state = memoryFallback.get(nonce);
  memoryFallback.delete(nonce);
  if (!state || Date.now() > state.expiresAt) return null;
  return { orgId: state.orgId };
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
