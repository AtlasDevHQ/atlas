/**
 * MCP bearer-token store + minting helpers (#2024).
 *
 * Tokens authenticate hosted MCP requests against a specific workspace.
 * They are issued from the admin `Settings → MCP Tokens` surface or via
 * the device-code OAuth flow (RFC 8628) — both follow-up PRs land on
 * top of this store. The bearer middleware in `mcp-bearer.ts` consumes
 * them on every MCP request.
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
 * candidates without decrypting every row. The prefix is a lookup
 * shard, not entropy — secret material lives in the 24-hex body
 * (96 bits, far past exhaustion).
 *
 * ── Revocation semantics ───────────────────────────────────────────
 *
 * `revoked_at` is a tombstone — never cleared. Lookup filters it out at
 * the SQL layer, so revocation is *immediate*: there is no in-process
 * cache to invalidate. The audit row for `mcp_token.revoke` references
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
// The plaintext bearer is `atl_mcp_<8 hex prefix><24 hex body>`. The
// 24-hex body carries the actual secret entropy (96 bits, far past
// exhaustion). The 8-hex prefix is non-secret — it is indexed in the
// DB and displayed in the UI for masked listings; treating it as
// entropy would be wrong even though it makes the bearer string look
// longer.
//
// `last_used_at` updates are sampled (≥ this many ms since the last
// recorded touch) so the hot path doesn't issue an UPDATE per request.
// 60s is a deliberate compromise — fine-grained enough that the admin
// UI's "last used" timestamp stays meaningful, coarse enough that a
// burst of MCP calls from a single agent doesn't add a write per call.

const TOKEN_PREFIX = "atl_mcp_";
const PREFIX_HEX_LEN = 8;   // chars after the literal prefix (lookup shard, NOT entropy)
const BODY_HEX_LEN = 24;    // 96 bits of secret entropy
const TOKEN_TOTAL_LEN = TOKEN_PREFIX.length + PREFIX_HEX_LEN + BODY_HEX_LEN; // 40
const LAST_USED_TOUCH_INTERVAL_MS = 60_000;
// Hot-path validator. Hoisted to module scope so we don't recompile
// the regex on every bearer middleware call.
const HEX_BODY_RE = /^[0-9a-f]+$/;

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
 * Lifecycle of an MCP token from the admin UI's perspective. Derived
 * from `revoked_at` / `expires_at` rather than stored as a column —
 * the timestamps remain the source of truth for *when*, this is the
 * source of truth for *what*. Revoked beats expired beats active so
 * a manually-revoked then-expired token still shows as revoked.
 */
export type McpTokenStatus = "active" | "expired" | "revoked";

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
  /** Derived from revoked_at / expires_at. UI renders off this, not the timestamps. */
  readonly status: McpTokenStatus;
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
 * device-code flow (RFC 8628) can re-use the same helper from a different
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
 *
 * The lookup itself is exact equality (`WHERE token_prefix = $1`), so
 * this validator is not a SQL-injection guard. It exists to fail-fast
 * on obviously-malformed bearers and avoid wasted DB roundtrips.
 */
export function splitTokenPrefix(token: string): string | null {
  if (token.length !== TOKEN_TOTAL_LEN) return null;
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const prefix = token.slice(0, TOKEN_PREFIX.length + PREFIX_HEX_LEN);
  if (!HEX_BODY_RE.test(prefix.slice(TOKEN_PREFIX.length))) return null;
  if (!HEX_BODY_RE.test(token.slice(prefix.length))) return null;
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

/** Outcome of `revokeMcpToken`. */
export interface RevokeOutcome {
  /** True iff this call performed the revocation. */
  readonly revoked: boolean;
  /**
   * Pre-existing tombstone, when the row was already revoked before
   * this call. Null on a fresh revocation OR when the row didn't
   * exist for the caller's org. The route distinguishes those cases
   * via the `prefix`/`name` fields below: both are populated whenever
   * the row exists for the caller's org.
   */
  readonly alreadyRevokedAt: Date | null;
  /** Token prefix, populated when the row was found for the caller's org. */
  readonly prefix: string | null;
  /** Token label, populated when the row was found for the caller's org. */
  readonly name: string | null;
}

/**
 * Revoke a token. Returns metadata about the row (prefix, name) so
 * the route layer can attach forensic context to the audit row that
 * survives even after the token row itself is hard-deleted by a
 * retention sweep.
 *
 * Scoped to `orgId` so a workspace admin cannot revoke tokens issued
 * against a different workspace by URL-tampering with the id. The
 * `WHERE revoked_at IS NULL` guard preserves the original tombstone
 * across idempotent re-revokes.
 */
export async function revokeMcpToken(input: {
  id: string;
  orgId: string;
}): Promise<RevokeOutcome> {
  const rows = await internalQuery<{
    token_prefix: string;
    name: string | null;
  }>(
    `UPDATE mcp_tokens
        SET revoked_at = NOW()
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
      RETURNING token_prefix, name`,
    [input.id, input.orgId],
  );

  if (rows.length > 0) {
    return {
      revoked: true,
      alreadyRevokedAt: null,
      prefix: rows[0].token_prefix,
      name: rows[0].name,
    };
  }

  // UPDATE matched nothing. Either the id doesn't exist, the org
  // doesn't own it, or it was already revoked — re-read to
  // disambiguate so the caller can return the right status code AND
  // attach prefix/name to the audit row in the already-revoked case.
  const lookup = await internalQuery<{
    revoked_at: Date | null;
    token_prefix: string;
    name: string | null;
  }>(
    `SELECT revoked_at, token_prefix, name
       FROM mcp_tokens
      WHERE id = $1 AND org_id = $2`,
    [input.id, input.orgId],
  );
  if (lookup.length === 0) {
    return { revoked: false, alreadyRevokedAt: null, prefix: null, name: null };
  }
  return {
    revoked: false,
    alreadyRevokedAt: lookup[0].revoked_at,
    prefix: lookup[0].token_prefix,
    name: lookup[0].name,
  };
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

  let decryptFailures = 0;

  for (const row of rows) {
    let storedHashHex: string;
    try {
      storedHashHex = decryptSecret(row.token_hash_encrypted);
    } catch (err) {
      // A decrypt failure on a single row should not poison the
      // sweep — log + skip so a corrupt or misversioned ciphertext
      // doesn't mask a sibling valid match. Rotation tooling
      // (`scripts/rotate-encryption-key.ts`) will surface the row
      // separately. The aggregate detector below promotes a
      // *systemic* failure (every candidate fell over) to a thrown
      // error so `validateMcpBearer` returns 500 instead of
      // wallpapering 401s during a keyset misconfiguration.
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          tokenId: row.id,
        },
        "mcp_token: decrypt failed for candidate row — skipping",
      );
      decryptFailures++;
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

  // Aggregate-failure detector: when there ARE candidate rows but
  // every one of them failed to decrypt, this is not a "no match"
  // outcome — it's a systemic outage (most likely a missing legacy
  // key in `ATLAS_ENCRYPTION_KEYS` after rotation). Throwing here
  // routes through `validateMcpBearer`'s 500 path and the
  // error-level log there, instead of returning null and surfacing
  // a quiet 401 to every customer.
  if (rows.length > 0 && decryptFailures === rows.length) {
    log.error(
      { prefix, candidateCount: rows.length },
      "mcp_token: every candidate row failed to decrypt — possible keyset misconfiguration",
    );
    throw new Error(
      "mcp_token: all candidate rows failed to decrypt — keyset misconfigured",
    );
  }

  return null;
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Compute the lifecycle status from the row's tombstone columns.
 * Revoked beats expired beats active — a row with both
 * `revoked_at` and a past `expires_at` reports as revoked.
 *
 * Exported so the admin-CRUD route can stamp the same status on the
 * `created` response without rebuilding the precedence rules.
 */
export function computeMcpTokenStatus(
  revokedAt: Date | null,
  expiresAt: Date | null,
  now: number = Date.now(),
): McpTokenStatus {
  if (revokedAt !== null) return "revoked";
  if (expiresAt !== null && expiresAt.getTime() <= now) return "expired";
  return "active";
}

function rowToSummary(row: McpTokenRow): McpTokenSummary {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    name: row.name,
    prefix: row.token_prefix,
    scopes: row.scopes ?? [],
    status: computeMcpTokenStatus(row.revoked_at, row.expires_at),
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
