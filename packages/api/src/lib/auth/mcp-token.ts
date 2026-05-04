/**
 * MCP bearer-token store + minting helpers (#2024).
 *
 * Tokens authenticate hosted MCP requests against a specific workspace.
 * They are issued from `Settings → MCP Tokens` (admin UI; PR D) or via
 * the device-code OAuth flow (PR C). The bearer middleware in
 * `mcp-bearer.ts` consumes them on every MCP request.
 *
 * ── Storage model ──────────────────────────────────────────────────
 *
 * Plaintext tokens are never persisted. We store SHA-256(token) and then
 * encrypt that hash at rest under the F-47 keyset. Defense-in-depth:
 *   - Hashing alone defeats plaintext recovery from a DB dump.
 *   - Encrypting the hash defeats offline trial-and-compare against the
 *     bare digest column. An attacker with read access to `mcp_tokens`
 *     cannot enumerate valid bearers without the encryption key.
 *
 * `token_prefix` is the public shard ("atl_mcp_<8 hex>") shown to users
 * in the UI and used by the bearer middleware to narrow lookup
 * candidates without decrypting every row. Prefix collisions are
 * negligible at 32 bits per workspace.
 *
 * ── Revocation semantics ───────────────────────────────────────────
 *
 * `revoked_at` is a tombstone — never cleared. Lookup filters it out at
 * the SQL layer, so revocation is *immediate*: there is no in-process
 * cache to invalidate. The audit row for `mcp.token.revoked` references
 * the surviving row by id.
 *
 * Issue: #2024
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  encryptSecret,
  decryptSecret,
  activeKeyVersion,
} from "@atlas/api/lib/db/secret-encryption";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("mcp-token");

// ── Public token format ─────────────────────────────────────────────
//
// The plaintext bearer is `atl_mcp_<8 hex prefix><24 hex body>`. 32
// hex chars = 128 bits of entropy, enough to make exhaustion infeasible
// even if `revoked_at` is somehow ignored. The prefix doubles as the
// lookup index in the DB and the masked display in the UI.
//
// `last_used_at` updates are sampled (≥ this many ms since the last
// recorded touch) so the hot path doesn't issue an UPDATE per request.
// 60s is a deliberate compromise — fine-grained enough that the admin
// UI's "last used" timestamp stays meaningful, coarse enough that a
// burst of MCP calls from a single agent doesn't add a write per call.

const TOKEN_PREFIX = "atl_mcp_";
const PREFIX_HEX_LEN = 8;   // chars after the literal prefix
const BODY_HEX_LEN = 24;    // remaining random bytes
const TOKEN_TOTAL_LEN = TOKEN_PREFIX.length + PREFIX_HEX_LEN + BODY_HEX_LEN; // 40
const LAST_USED_TOUCH_INTERVAL_MS = 60_000;

/**
 * Result of `createMcpToken`. The plaintext `token` is returned exactly
 * once — callers must surface it to the user immediately and never log
 * or persist it. Subsequent reads only have access to `prefix` (for
 * masked display: `atl_mcp_abcdef12…`).
 */
export interface CreatedMcpToken {
  readonly id: string;
  /** Plaintext bearer. Shown to the user once at creation, then discarded. */
  readonly token: string;
  readonly prefix: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly name: string | null;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Row shape returned by `listMcpTokens`. Excludes `token_hash_encrypted`
 * — there is no surface that needs the encrypted hash outside of the
 * lookup hot path. Including it would make it easier to leak the column
 * into an admin UI response by accident.
 */
export interface McpTokenSummary {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: ReadonlyArray<string>;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly createdByUserId: string | null;
}

/**
 * Bound identity returned when the bearer middleware successfully
 * resolves a token. The shape is intentionally narrow — the middleware
 * uses these fields to construct an `AtlasUser` for `AuthContext`.
 */
export interface ResolvedMcpIdentity {
  readonly tokenId: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly scopes: ReadonlyArray<string>;
}

// Intersection with `Record<string, unknown>` so this type satisfies the
// `internalQuery<T extends Record<string, unknown>>` constraint without
// losing per-field types.
type McpTokenRow = Record<string, unknown> & {
  id: string;
  org_id: string;
  user_id: string | null;
  name: string | null;
  token_prefix: string;
  token_hash_encrypted: string;
  token_hash_key_version: number;
  scopes: string[];
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  created_by_user_id: string | null;
};

// ── Pure helpers (no DB) ────────────────────────────────────────────

/**
 * Generate a fresh plaintext token plus the derived prefix and SHA-256
 * digest. Pure — no DB writes, no encryption. Callers compose this with
 * `encryptSecret(hashHex)` to produce the row's stored ciphertext.
 *
 * Exposed (rather than inlined into `createMcpToken`) so tests can
 * verify the format invariants without touching the DB and so the
 * device-code flow (PR C) can re-use the same helper from a different
 * code path.
 */
export function generateMcpToken(): {
  token: string;
  prefix: string;
  hashHex: string;
} {
  const prefixBytes = randomBytes(PREFIX_HEX_LEN / 2).toString("hex");
  const bodyBytes = randomBytes(BODY_HEX_LEN / 2).toString("hex");
  const prefix = `${TOKEN_PREFIX}${prefixBytes}`;
  const token = `${prefix}${bodyBytes}`;
  return { token, prefix, hashHex: hashTokenSha256(token) };
}

/** Lowercase hex SHA-256 of the token. Same digest is used to compare on read. */
export function hashTokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Extract the public prefix from a plaintext token. Returns null when
 * the input is not a valid Atlas MCP bearer — the middleware uses that
 * branch to short-circuit before issuing a DB query.
 */
export function splitTokenPrefix(token: string): string | null {
  if (token.length !== TOKEN_TOTAL_LEN) return null;
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const prefix = token.slice(0, TOKEN_PREFIX.length + PREFIX_HEX_LEN);
  // Validate the hex shape so a malformed token (e.g. attacker
  // probing prefix collisions with non-hex chars) doesn't produce a
  // surprising LIKE-style query.
  const HEX = /^[0-9a-f]+$/;
  if (!HEX.test(prefix.slice(TOKEN_PREFIX.length))) return null;
  if (!HEX.test(token.slice(prefix.length))) return null;
  return prefix;
}

// ── DB-coupled helpers ──────────────────────────────────────────────

/**
 * Mint a new MCP token bound to `orgId`. Returns the plaintext token
 * exactly once — the caller is responsible for surfacing it to the
 * user and discarding it.
 */
export async function createMcpToken(input: {
  orgId: string;
  userId: string | null;
  name?: string | null;
  scopes?: ReadonlyArray<string>;
  expiresAt?: Date | null;
}): Promise<CreatedMcpToken> {
  const { token, prefix, hashHex } = generateMcpToken();
  const id = `mcp_${randomBytes(8).toString("hex")}`;
  const scopes = input.scopes ?? [];
  const expiresAt = input.expiresAt ?? null;
  const name = input.name ?? null;

  const encryptedHash = encryptSecret(hashHex);
  const keyVersion = activeKeyVersion();

  await internalQuery(
    `INSERT INTO mcp_tokens
       (id, org_id, user_id, name, token_prefix,
        token_hash_encrypted, token_hash_key_version,
        scopes, expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.orgId,
      input.userId,
      name,
      prefix,
      encryptedHash,
      keyVersion,
      scopes,
      expiresAt,
      input.userId,
    ],
  );

  return {
    id,
    token,
    prefix,
    orgId: input.orgId,
    userId: input.userId,
    name,
    scopes,
    expiresAt,
    createdAt: new Date(),
  };
}

/**
 * List every token for a workspace. Includes revoked rows — the admin
 * UI surfaces revocation state with a struck-through row rather than
 * hiding it (so a user can see when a token was revoked and by whom
 * via the linked audit log entry).
 */
export async function listMcpTokensForOrg(
  orgId: string,
): Promise<ReadonlyArray<McpTokenSummary>> {
  const rows = await internalQuery<McpTokenRow>(
    `SELECT id, org_id, user_id, name, token_prefix,
            token_hash_encrypted, token_hash_key_version,
            scopes, last_used_at, expires_at, revoked_at,
            created_at, created_by_user_id
       FROM mcp_tokens
      WHERE org_id = $1
      ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(rowToSummary);
}

/**
 * Revoke a token. Returns the prior revoked_at if the row already
 * carried one, or null when this call performed the revocation. The
 * route layer uses the difference to suppress duplicate audit rows on
 * idempotent re-revoke.
 *
 * Scoped to `orgId` so a workspace admin cannot revoke tokens issued
 * against a different workspace by URL-tampering with the id.
 */
export async function revokeMcpToken(input: {
  id: string;
  orgId: string;
}): Promise<{ revoked: boolean; alreadyRevokedAt: Date | null }> {
  const rows = await internalQuery<{
    revoked_at: Date | null;
    prior_revoked_at: Date | null;
  }>(
    // First-revocation path uses `WHERE revoked_at IS NULL` so a second
    // call doesn't overwrite the original tombstone (preserves the
    // forensic timestamp). The RETURNING clause distinguishes the
    // two outcomes: `revoked_at` is the post-update value, while
    // `prior_revoked_at` came from the SELECT subquery above the UPDATE.
    `WITH prior AS (
       SELECT revoked_at FROM mcp_tokens WHERE id = $1 AND org_id = $2
     )
     UPDATE mcp_tokens
        SET revoked_at = NOW()
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
      RETURNING revoked_at,
                (SELECT revoked_at FROM prior) AS prior_revoked_at`,
    [input.id, input.orgId],
  );

  if (rows.length === 0) {
    // No row updated. Either the id doesn't exist, the org doesn't
    // own it, or it was already revoked. Re-read to disambiguate so
    // the caller can return the right status code.
    const lookup = await internalQuery<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM mcp_tokens WHERE id = $1 AND org_id = $2`,
      [input.id, input.orgId],
    );
    if (lookup.length === 0) {
      return { revoked: false, alreadyRevokedAt: null };
    }
    return { revoked: false, alreadyRevokedAt: lookup[0].revoked_at };
  }

  return { revoked: true, alreadyRevokedAt: null };
}

/**
 * Resolve a bearer string to a workspace identity, or null when the
 * token is unknown / expired / revoked. Performs the prefix-narrowed
 * lookup, decrypts each candidate's hash, and constant-time compares
 * against `SHA-256(bearer)`.
 *
 * Side effect: best-effort `last_used_at` touch (sampled — see
 * LAST_USED_TOUCH_INTERVAL_MS). Touch failures never block the request.
 */
export async function lookupMcpTokenByBearer(
  bearer: string,
): Promise<ResolvedMcpIdentity | null> {
  const prefix = splitTokenPrefix(bearer);
  if (!prefix) return null;

  const incomingHashHex = hashTokenSha256(bearer);
  const incomingHashBuf = Buffer.from(incomingHashHex, "hex");

  const rows = await internalQuery<{
    id: string;
    org_id: string;
    user_id: string | null;
    scopes: string[];
    token_hash_encrypted: string;
    expires_at: Date | null;
    last_used_at: Date | null;
  }>(
    `SELECT id, org_id, user_id, scopes,
            token_hash_encrypted, expires_at, last_used_at
       FROM mcp_tokens
      WHERE token_prefix = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [prefix],
  );

  for (const row of rows) {
    let storedHashHex: string;
    try {
      storedHashHex = decryptSecret(row.token_hash_encrypted);
    } catch (err) {
      // A decrypt failure on a single row should not poison the
      // sweep — log + skip so a corrupt or misversioned ciphertext
      // doesn't mask a sibling valid match. Rotation tooling
      // (`scripts/rotate-encryption-key.ts`) will surface the row
      // separately.
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          tokenId: row.id,
        },
        "mcp_token: decrypt failed for candidate row — skipping",
      );
      continue;
    }

    const storedHashBuf = Buffer.from(storedHashHex, "hex");
    if (storedHashBuf.length !== incomingHashBuf.length) continue;
    if (!timingSafeEqual(storedHashBuf, incomingHashBuf)) continue;

    void touchLastUsed(row.id, row.last_used_at);

    return {
      tokenId: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      scopes: row.scopes ?? [],
    };
  }

  return null;
}

// ── Internal helpers ────────────────────────────────────────────────

function rowToSummary(row: McpTokenRow): McpTokenSummary {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: row.scopes ?? [],
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
  };
}

async function touchLastUsed(
  id: string,
  lastUsedAt: Date | null,
): Promise<void> {
  if (lastUsedAt) {
    const elapsed = Date.now() - lastUsedAt.getTime();
    if (elapsed < LAST_USED_TOUCH_INTERVAL_MS) return;
  }
  try {
    await internalQuery(
      `UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = $1`,
      [id],
    );
  } catch (err) {
    // last_used_at is observability, not a security control. Failing
    // to update should not block the request — log and continue.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tokenId: id,
      },
      "mcp_token: failed to update last_used_at",
    );
  }
}

// Test hook for lookup tests that need to assert touch behavior without
// waiting on the sampling interval. Not exported from the package
// surface — only the in-tree tests need it.
export const __INTERNAL = {
  TOKEN_PREFIX,
  TOKEN_TOTAL_LEN,
  LAST_USED_TOUCH_INTERVAL_MS,
} as const;
