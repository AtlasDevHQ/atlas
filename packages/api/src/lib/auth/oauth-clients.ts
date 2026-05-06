/**
 * Shared OAuth-client query + revoke helpers (#2065).
 *
 * 1.4.0's admin OAuth-clients page (#2024 / #2062) and 1.4.1's per-user
 * `/settings/ai-agents` surface (#2065) both list and revoke the same
 * Better-Auth `oauthClient` rows — they only differ in scope:
 *
 *   - Admin sees every client registered in the workspace
 *     (`referenceId = orgId`).
 *   - A workspace user sees only the clients they personally registered
 *     (`userId = self AND referenceId = orgId`).
 *
 * Revocation atomicity (the four ordered DELETEs inside one transaction
 * with race + rollback handling) is identical between the two callers.
 * Forking the SQL between two route files would mean any future schema
 * change (FK direction, ON DELETE policy, new outstanding-token table) has
 * to land in two places. This module is the single source.
 *
 * Pure helpers — no Effect, no audit, no HTTP. Callers wrap with their own
 * `Effect.promise(...)`, audit emission, and runHandler bridging. The
 * helper returns a discriminated `RevokeOutcome` so the route can branch on
 * success / race / rolled-back without exception handling, and emit the
 * phase-aware audit metadata that the F-29 forensic queries already pivot
 * on.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("oauth-clients-helper");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Token-state classification surfaced to the per-user UI (#2066).
 *
 * - `active`              — the client is enabled and has at least one
 *                           outstanding non-expired access OR refresh
 *                           token. The agent should be able to make a
 *                           tools/call without user-visible re-auth.
 * - `reconnect_required`  — the client is enabled but every access
 *                           token has expired *and* no usable refresh
 *                           token remains (refresh exhausted or never
 *                           issued). The UI surfaces a re-run-wizard CTA.
 * - `revoked`             — the client row is `disabled = true`.
 *                           **As of v1.4.1, no production code path
 *                           produces this state**: `revokeOAuthClient`
 *                           performs a hard `DELETE FROM "oauthClient"`,
 *                           so a revoked client disappears from the
 *                           list query entirely. The state is reserved
 *                           for a future soft-revoke flow that flips
 *                           `disabled` without removing the row (so the
 *                           audit trail stays intact under whole-row
 *                           retention policy). The UI rendering and
 *                           tests exist now to keep the contract
 *                           pinned for that future flow.
 *
 * The `disabled` flag is authoritative for `revoked` regardless of
 * outstanding token counts — when the soft-revoke flow lands, tokens
 * may not yet be cascaded by the time the list query reads, and the
 * UI must already say "Revoked" rather than "Active."
 */
export type OAuthTokenState = "active" | "reconnect_required" | "revoked";

/**
 * One row of the per-client list query. Wire shape — kept aligned with the
 * Zod `OAuthClientSchema` in `me-schemas.ts` so the API edge and the web
 * page agree without a third translation layer. `tokenCount` is normalised
 * to `number` here (Postgres `COUNT(*)` returns string) so callers receive
 * a consistent shape.
 *
 * `tokenState` is derived in SQL (see `listOAuthClients`) so the UI
 * can render Active / Reconnect required / Revoked without needing a
 * second roundtrip per client. `tokenCount` continues to count *all*
 * outstanding rows including expired ones — the legacy "active tokens"
 * UI string is informational; the new state badge is the load-bearing
 * health signal.
 */
export interface OAuthClientRow {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
  updatedAt: string | null;
  disabled: boolean;
  type: string | null;
  lastUsedAt: string | null;
  tokenCount: number;
  tokenState: OAuthTokenState;
}

export type RevokePhase =
  | "access_tokens"
  | "refresh_tokens"
  | "consent"
  | "client"
  | "commit";

export type RevokeOutcome =
  | { status: "ok"; access: number; refresh: number; consent: number }
  | { status: "race" }
  | {
      status: "rolled_back";
      phase: RevokePhase;
      error: Error;
      /**
       * Set when ROLLBACK itself threw (TCP reset between BEGIN and
       * ROLLBACK, statement timeout in the rollback path, etc). The pino
       * `log.warn` always fires, but surfacing it back to the route lets
       * the audit row pivot on rollback success — without this, an
       * `admin_action_log` reviewer can't tell whether the partial
       * child DELETEs were cleanly reverted or the connection was
       * destroyed mid-recovery.
       */
      rollbackError?: Error;
    };

/**
 * Discriminated scope: a query is either workspace-wide (admin) or
 * additionally filtered to a single user (the per-user surface in #2065).
 *
 * `orgId` is always present. On the user variant, `userId` is the
 * load-bearing IDOR check — the admin variant intentionally has none, since
 * an admin is entitled to every client in the workspace. `orgId` on the
 * user variant is defense-in-depth tenant isolation: a bug that lets a
 * `userId` from workspace A surface inside workspace B's session must not
 * be enough on its own to leak that user's other-workspace clients
 * (DCR-registered clients are scoped to a single workspace at
 * registration time, so the two filters together pin the row uniquely).
 */
export type OAuthClientScope =
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string; orgId: string };

// ---------------------------------------------------------------------------
// SELECT — list clients in scope
// ---------------------------------------------------------------------------

/**
 * Returns every OAuth client visible under `scope`, with the most-recent
 * access-token issuance and outstanding-token count joined in. Sorted
 * newest-first so the list view matches what the user just connected.
 */
export async function listOAuthClients(scope: OAuthClientScope): Promise<OAuthClientRow[]> {
  const params: unknown[] = [scope.orgId];
  let userClause = "";
  let tokenUserClause = "";
  if (scope.kind === "user") {
    params.push(scope.userId);
    userClause = `AND c."userId" = $2`;
    // The LEFT-JOIN counts must filter by the same user so a client with
    // tokens from multiple users (shouldn't happen — DCR clients are
    // single-user — but defense in depth) reports the calling user's
    // outstanding count, not the global one.
    tokenUserClause = `AND t."userId" = $2`;
  }

  // The `liveTokenCount` and `liveRefreshCount` aggregates feed the
  // tokenState derivation below. We intentionally count "live" (non-
  // expired) rows separately from the legacy `tokenCount` (every row,
  // expired or not) so the UI can keep displaying "tokens issued" while
  // gaining a precise health signal. NOW() is preferred over a JS-side
  // Date.now() so the read is consistent with whatever transaction
  // isolation the connection runs at — and so unit tests against a
  // fixed-clock fixture don't drift.
  const rows = await internalQuery<{
    clientId: string;
    clientName: string | null;
    redirectUris: string[] | null;
    createdAt: string;
    updatedAt: string | null;
    disabled: boolean | null;
    type: string | null;
    lastUsedAt: string | null;
    tokenCount: string;
    liveTokenCount: string;
    liveRefreshCount: string;
  }>(
    `SELECT c."clientId" AS "clientId",
            c."name" AS "clientName",
            c."redirectUris" AS "redirectUris",
            c."createdAt" AS "createdAt",
            c."updatedAt" AS "updatedAt",
            c."disabled" AS "disabled",
            c."type" AS "type",
            MAX(t."createdAt") AS "lastUsedAt",
            COUNT(t."id") AS "tokenCount",
            COUNT(t."id") FILTER (WHERE t."expiresAt" > NOW()) AS "liveTokenCount",
            (
              SELECT COUNT(*)
                FROM "oauthRefreshToken" r
               WHERE r."clientId" = c."clientId"
                 AND r."referenceId" = c."referenceId"
                 ${scope.kind === "user" ? `AND r."userId" = $2` : ""}
                 AND (r."revoked" IS NULL)
                 AND (r."expiresAt" IS NULL OR r."expiresAt" > NOW())
            ) AS "liveRefreshCount"
       FROM "oauthClient" c
       LEFT JOIN "oauthAccessToken" t
         ON t."clientId" = c."clientId"
        AND t."referenceId" = c."referenceId"
        ${tokenUserClause}
       WHERE c."referenceId" = $1
         ${userClause}
       GROUP BY c."id", c."clientId", c."name", c."redirectUris", c."createdAt",
                c."updatedAt", c."disabled", c."type", c."referenceId"
       ORDER BY c."createdAt" DESC`,
    params,
  );

  return rows.map((r): OAuthClientRow => {
    const disabled = Boolean(r.disabled);
    // pg returns COUNT(*) as a string. NaN from a NULL aggregate would
    // silently classify a healthy active client as "reconnect_required"
    // (NaN > 0 → false → falls through to the default branch) — exactly
    // the false-negative-fallback CLAUDE.md prohibits. A NULL here means
    // the SQL or the schema drifted; surface a 500 with a `requestId`
    // rather than render a wrong status badge.
    const liveAccess = Number.parseInt(r.liveTokenCount ?? "", 10);
    const liveRefresh = Number.parseInt(r.liveRefreshCount ?? "", 10);
    if (!Number.isFinite(liveAccess) || !Number.isFinite(liveRefresh)) {
      throw new Error(
        `oauth-clients aggregate parse failed for clientId=${r.clientId} `
        + `(liveTokenCount=${String(r.liveTokenCount)}, `
        + `liveRefreshCount=${String(r.liveRefreshCount)})`,
      );
    }
    // Three-state collapse, in precedence order:
    //   1. disabled  → "revoked" wins regardless of outstanding tokens
    //                  (reserved for a future soft-revoke flow that
    //                  flips `disabled` without DELETEing the row;
    //                  current `revokeOAuthClient` does a hard DELETE
    //                  so disabled-with-rows never actually surfaces
    //                  in v1.4.1).
    //   2. liveAccess > 0 → "active": at least one token will verify
    //                  on the next agent frame.
    //   3. liveRefresh > 0 → "active": no live access token, but the
    //                  refresh path will mint one transparently.
    //   4. otherwise → "reconnect_required": agent's MCP SDK will 401
    //                  on next frame and cannot recover without re-DCR.
    const tokenState: OAuthTokenState = disabled
      ? "revoked"
      : liveAccess > 0 || liveRefresh > 0
        ? "active"
        : "reconnect_required";

    return {
      clientId: r.clientId,
      clientName: r.clientName,
      redirectUris: r.redirectUris ?? [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      disabled,
      type: r.type,
      lastUsedAt: r.lastUsedAt,
      tokenCount: parseInt(r.tokenCount, 10),
      tokenState,
    };
  });
}

// ---------------------------------------------------------------------------
// SELECT — pre-fetch one client (audit + cross-tenant probe detection)
// ---------------------------------------------------------------------------

/**
 * Returns the `clientId` + `clientName` for a single client visible under
 * `scope`, or `null` if no row matches. Used by revoke to (a) capture the
 * client name for audit metadata before the DELETE strips the row, and
 * (b) emit a `found: false` audit row for cross-user / cross-org probes.
 */
export async function findOAuthClient(
  clientId: string,
  scope: OAuthClientScope,
): Promise<{ clientId: string; clientName: string | null } | null> {
  const params: unknown[] = [clientId, scope.orgId];
  let userClause = "";
  if (scope.kind === "user") {
    params.push(scope.userId);
    userClause = `AND "userId" = $3`;
  }

  const rows = await internalQuery<{ clientId: string; clientName: string | null }>(
    `SELECT "clientId", "name" AS "clientName"
       FROM "oauthClient"
       WHERE "clientId" = $1 AND "referenceId" = $2
         ${userClause}`,
    params,
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// DELETE — atomic revoke
// ---------------------------------------------------------------------------

/**
 * Atomically revokes `clientId` under `scope`. All four DELETEs run inside
 * one transaction; partial-state failures roll back so the workspace never
 * ends up with stale refresh tokens after a 500.
 *
 * Returns a discriminated outcome so the caller can branch on success /
 * race / rolled-back without exception handling. Race detection: pre-fetch
 * is outside this transaction, so a concurrent revoke can win between
 * pre-fetch and BEGIN — the parent DELETE seeing zero rows is the signal.
 *
 * For `kind: "user"` scope, every DELETE also filters by `userId` — the
 * IDOR check that prevents user A revoking user B's client by guessing
 * the clientId. The `referenceId = orgId` filter remains as defense in
 * depth even though a single (clientId, userId) tuple is unique.
 */
export async function revokeOAuthClient(
  clientId: string,
  scope: OAuthClientScope,
): Promise<RevokeOutcome> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let phase: RevokePhase = "access_tokens";
  let rollbackErr: Error | null = null;

  // The user-scoped DELETEs require an extra `AND "userId" = $userParam`
  // clause on every table. `extra` is appended verbatim to each DELETE so
  // the four statements stay parameter-aligned.
  const baseParams: unknown[] = [clientId, scope.orgId];
  let extra = "";
  if (scope.kind === "user") {
    baseParams.push(scope.userId);
    extra = `AND "userId" = $3`;
  }

  try {
    await client.query("BEGIN");

    const access = await client.query(
      `DELETE FROM "oauthAccessToken"
        WHERE "clientId" = $1 AND "referenceId" = $2 ${extra}
        RETURNING "id"`,
      baseParams,
    );
    phase = "refresh_tokens";

    const refresh = await client.query(
      `DELETE FROM "oauthRefreshToken"
        WHERE "clientId" = $1 AND "referenceId" = $2 ${extra}
        RETURNING "id"`,
      baseParams,
    );
    phase = "consent";

    const consent = await client.query(
      `DELETE FROM "oauthConsent"
        WHERE "clientId" = $1 AND "referenceId" = $2 ${extra}
        RETURNING "id"`,
      baseParams,
    );
    phase = "client";

    const deleted = await client.query(
      `DELETE FROM "oauthClient"
        WHERE "clientId" = $1 AND "referenceId" = $2 ${extra}
        RETURNING "clientId"`,
      baseParams,
    );

    // Race: pre-fetch saw the row but the transactional DELETE missed it.
    // A concurrent admin / duplicate request revoked the same client
    // between the pre-fetch and BEGIN. Roll back so the partial child
    // DELETEs revert — without rollback, the children would be gone but
    // the parent client (now owned by the racing tx) would survive.
    if (deleted.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: "race" };
    }

    phase = "commit";
    await client.query("COMMIT");

    return {
      status: "ok",
      access: access.rows.length,
      refresh: refresh.rows.length,
      consent: consent.rows.length,
    };
  } catch (err) {
    // ROLLBACK can itself fail (TCP reset between BEGIN and ROLLBACK). pg
    // destroys the socket when `release(err)` is called with a truthy
    // arg, so a poisoned client doesn't return to the pool to corrupt
    // the next borrower's transaction. The rollback error also flows
    // back to the caller via `rollbackError` so the audit row can pivot
    // on rollback success — without this, a forensic reviewer can't
    // distinguish a clean revert from a destroyed connection.
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { err: rollbackErr.message, clientId, scopeKind: scope.kind, phase },
        "ROLLBACK failed after revoke error — client will be destroyed",
      );
    });
    return {
      status: "rolled_back",
      phase,
      error: err instanceof Error ? err : new Error(String(err)),
      ...(rollbackErr ? { rollbackError: rollbackErr } : {}),
    };
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}
