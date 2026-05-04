/**
 * Admin CRUD routes for MCP bearer tokens (#2024).
 *
 * Mounted under /api/v1/admin/mcp-tokens. Org-scoped: every query
 * filters on `mcp_tokens.org_id` matching the caller's active
 * organization, so a workspace admin can only see / mint / revoke
 * tokens for their own workspace.
 *
 * Surface:
 *   GET  /                      — list tokens for caller's org
 *   POST /                      — mint a new token (returns plaintext once)
 *   POST /{id}/revoke           — revoke an existing token
 *
 * Audit emission contract:
 *   - `mcp_token.create`  (success path, route emits; on audit
 *      failure the freshly-inserted row is DELETEd before the 500
 *      propagates, so a 500 from this endpoint never leaves an
 *      authenticatable bearer in the table without a forensic row)
 *   - `mcp_token.revoke`  (success path, route emits; idempotent
 *      re-revoke does NOT emit a second row — the audit trail must
 *      reflect when the token was actually revoked, not every time
 *      somebody clicks the button. Metadata carries the row's
 *      prefix and name so forensic queries pivot correctly even
 *      after retention sweeps the row itself)
 *   - `mcp_token.use`     (NOT emitted here — owned by the bearer
 *      middleware on first-use, sampled, in a follow-up PR)
 *
 * Cross-org probe defence: a workspace admin from org-A passing an
 * id that belongs to org-B sees a 404 (no oracle distinguishing
 * "doesn't exist" from "exists but not yours"), and the route emits
 * a `log.warn` so a SIEM can detect the probe pattern even though
 * the response itself is indistinguishable from "doesn't exist".
 *
 * The `_encrypted` rule: the token-store helpers
 * (`createMcpToken` / `lookupMcpTokenByBearer`) own all
 * encrypt/decrypt boundaries. This file never touches the encrypted
 * column directly.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import {
  createMcpToken,
  listMcpTokensForOrg,
  revokeMcpToken,
  computeMcpTokenStatus,
  type McpTokenSummary,
} from "@atlas/api/lib/auth/mcp-token";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-mcp-tokens");

// ── Schemas ─────────────────────────────────────────────────────────

const TokenSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prefix: z.string().openapi({
    description:
      "Public prefix for masked display (`atl_mcp_abcdef12…`). Safe to log.",
  }),
  scopes: z.array(z.string()),
  /**
   * Derived lifecycle state. Surfaced so clients render off a
   * literal instead of computing precedence from three nullable
   * timestamps (revoked > expired > active). The timestamps remain
   * for audit/UI ("revoked just now") but should not drive control
   * flow.
   */
  status: z.enum(["active", "expired", "revoked"]).openapi({
    description:
      "Lifecycle state derived from revoked_at/expires_at. Render off this; revoked beats expired beats active.",
  }),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  createdByUserId: z.string().nullable(),
});

const CreateBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional().openapi({
    example: "Claude Desktop",
    description:
      "Optional human-readable label for the token. Surfaced in the admin list view.",
  }),
  scopes: z.array(z.string().min(1)).max(16).optional().openapi({
    example: [],
    description:
      "Reserved for future scope-restriction. Empty array = full MCP access for the workspace. Today only the empty array is meaningful.",
  }),
  expiresInDays: z.number().int().min(1).max(365).optional().openapi({
    example: 90,
    description:
      "Optional expiry window. Omit for a non-expiring token. Capped at 365 days; longer-lived tokens should be re-minted instead of refreshed.",
  }),
});

const CreateResponseSchema = z.object({
  /**
   * The plaintext token, returned EXACTLY ONCE at mint time. The
   * response shape is documented loudly so the UI surfaces a
   * "copy this — you'll never see it again" affordance, not a
   * "tokens" list with a hidden field.
   */
  token: z.string().openapi({
    description:
      "The plaintext bearer. Returned exactly once — copy it now; subsequent reads only see the prefix.",
  }),
  summary: TokenSummarySchema,
});

const RevokeParamsSchema = z.object({
  id: z.string().min(1).openapi({
    param: { in: "path", name: "id" },
    description: "Token id from the list endpoint.",
  }),
});

// ── Route definitions ──────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — MCP Tokens"],
  summary: "List MCP tokens for the active workspace",
  description:
    "Returns every MCP token issued against the caller's active workspace, including revoked rows so the UI can render them with a tombstone state.",
  responses: {
    200: {
      description: "Token list",
      content: {
        "application/json": {
          schema: z.object({ tokens: z.array(TokenSummarySchema) }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — MCP Tokens"],
  summary: "Mint a new MCP bearer token",
  description:
    "Creates a new MCP token bound to the caller's active workspace and the calling user. The plaintext token is returned once in the response — the server never persists or returns the plaintext again.",
  request: {
    body: { required: false, content: { "application/json": { schema: CreateBodySchema } } },
  },
  responses: {
    200: {
      description: "Created token (plaintext returned exactly once)",
      content: { "application/json": { schema: CreateResponseSchema } },
    },
    400: { description: "Invalid body or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeRouteDef = createRoute({
  method: "post",
  path: "/{id}/revoke",
  tags: ["Admin — MCP Tokens"],
  summary: "Revoke an MCP bearer token",
  description:
    "Marks the token revoked immediately. Subsequent bearer requests using the token are rejected on their very next call — there is no in-process cache to invalidate.",
  request: { params: RevokeParamsSchema },
  responses: {
    200: {
      description: "Revoked",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            revokedAt: z.string(),
            alreadyRevoked: z.boolean(),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Token not found in this workspace", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Render an `McpTokenSummary` to its JSON wire shape. Typed against
 * the imported `McpTokenSummary` (not an inline structural type) so
 * that adding a field on the source-of-truth interface forces a
 * compile error here instead of silently dropping the field on the
 * wire.
 */
function summaryToWire(s: McpTokenSummary) {
  return {
    id: s.id,
    name: s.name,
    prefix: s.prefix,
    scopes: [...s.scopes],
    status: s.status,
    lastUsedAt: s.lastUsedAt ? s.lastUsedAt.toISOString() : null,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    createdByUserId: s.createdByUserId,
  };
}

/**
 * Best-effort cleanup of a freshly-minted token row when the
 * subsequent audit emission fails. The DELETE removes the bearer
 * before the 500 propagates so a retry doesn't accumulate orphan
 * authenticatable tokens. Failures here are logged but never mask
 * the original audit error — the route still returns 500 so an
 * operator notices.
 */
async function deleteOrphanToken(id: string, orgId: string, requestId: string): Promise<void> {
  try {
    await internalQuery(
      `DELETE FROM mcp_tokens WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
  } catch (cleanupErr) {
    log.error(
      {
        err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        tokenId: id,
        requestId,
      },
      "mcp_token.create cleanup DELETE failed — orphan row may persist; investigate",
    );
  }
}

// ── Router ─────────────────────────────────────────────────────────

const adminMcpTokens = createAdminRouter();
adminMcpTokens.use(requireOrgContext());

// GET / — list
adminMcpTokens.openapi(listRoute, async (c) =>
  runHandler(c, "list MCP tokens", async () => {
    const { orgId } = c.get("orgContext");
    const rows = await listMcpTokensForOrg(orgId);
    return c.json(
      { tokens: rows.map((r) => summaryToWire(r)) },
      200,
    );
  }),
);

// POST / — create
adminMcpTokens.openapi(createRouteDef, async (c) =>
  runHandler(c, "create MCP token", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const authResult = c.get("authResult");
    const userId = authResult.user?.id ?? null;

    // OpenAPI's validationHook (defaultHook) already returns 422 on
    // a malformed body, so we only reach this handler when the body
    // is either valid or absent. `c.req.valid("json")` is undefined
    // when no body was sent — fall back to an empty input.
    const validated =
      (c.req.valid("json") as z.infer<typeof CreateBodySchema> | undefined) ??
      {};

    const expiresAt = validated.expiresInDays
      ? new Date(Date.now() + validated.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const created = await createMcpToken({
      orgId,
      userId,
      name: validated.name ?? null,
      scopes: validated.scopes ?? [],
      expiresAt,
    });

    // Emit the audit row BEFORE returning so a 200 cannot ship
    // without a forensic record. If the audit write fails, DELETE
    // the freshly-minted row before propagating 500 — without the
    // cleanup, the row stays valid for `lookupMcpTokenByBearer`
    // forever with no client copy of the plaintext and no audit
    // trail. The 500 still surfaces so the admin notices and the
    // (idempotent) retry mints a fresh token from a clean state.
    try {
      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.mcp_token.create,
        targetType: "mcp_token",
        targetId: created.id,
        metadata: {
          name: created.name,
          prefix: created.prefix,
          scopes: created.scopes,
          // Surface only the boolean — the actual ISO timestamp lives
          // in the row itself. Logs index on category, not stamp.
          hasExpiry: created.expiresAt !== null,
        },
      });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          tokenId: created.id,
          requestId,
        },
        "mcp_token.create audit emission failed — deleting orphan row and propagating 500",
      );
      await deleteOrphanToken(created.id, orgId, requestId);
      throw err;
    }

    return c.json(
      {
        token: created.token,
        summary: {
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          scopes: [...created.scopes],
          // A freshly-minted token is always active. If we ever
          // return one in any other state we have a bigger problem
          // than the wire shape.
          status: computeMcpTokenStatus(null, created.expiresAt) as
            | "active"
            | "expired"
            | "revoked",
          lastUsedAt: null,
          expiresAt: created.expiresAt
            ? created.expiresAt.toISOString()
            : null,
          revokedAt: null,
          createdAt: created.createdAt.toISOString(),
          createdByUserId: userId,
        },
      },
      200,
    );
  }),
);

// POST /{id}/revoke — revoke
adminMcpTokens.openapi(revokeRouteDef, async (c) =>
  runHandler(c, "revoke MCP token", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const id = c.req.param("id");

    const result = await revokeMcpToken({ id, orgId });

    // No row at all — return 404 so the caller doesn't see "200, but
    // it wasn't actually yours". Distinguishes a non-existent token
    // from a still-revocable one. Also a cross-org probe surface:
    // a workspace admin from org-A passing org-B's id ends up here.
    // The 4xx wording is the same as a genuine missing row (no
    // oracle distinguishing the two), but a SIEM tailing this
    // log.warn can detect the probe pattern across many requests.
    if (!result.revoked && result.alreadyRevokedAt === null) {
      log.warn(
        { requestId, orgId, tokenId: id },
        "mcp_token.revoke targeted unknown id — returned 404 (could be cross-org probe)",
      );
      return c.json(
        {
          error: "not_found",
          message: "MCP token not found in this workspace.",
          requestId,
        },
        404,
      );
    }

    if (result.revoked) {
      try {
        await logAdminActionAwait({
          actionType: ADMIN_ACTIONS.mcp_token.revoke,
          targetType: "mcp_token",
          targetId: id,
          metadata: {
            // Pre-fetched in the same UPDATE that performed the
            // revocation so the audit row survives even after a
            // future retention sweep hard-deletes the source row.
            // Forensic queries pivot on prefix without joining
            // `mcp_tokens`.
            prefix: result.prefix,
            name: result.name,
          },
        });
      } catch (err) {
        // Audit write failure on the revoke path is severe — a
        // revocation without a forensic row leaves no trail of who
        // killed the token. Surface the 500 so the admin retries
        // (revocation is idempotent — the second call is a no-op
        // tombstone-already-set, but the audit row gets written).
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            tokenId: id,
            requestId,
          },
          "mcp_token.revoke audit emission failed — propagating 500",
        );
        throw err;
      }
    }

    const revokedAt =
      result.alreadyRevokedAt ??
      // result.revoked === true implies the row was just updated;
      // the precise stamp is `NOW()` from the SQL — within a few ms
      // of the response, fine for the UI's "revoked just now" copy.
      new Date();
    return c.json(
      {
        id,
        revokedAt: revokedAt.toISOString(),
        alreadyRevoked: !result.revoked,
      },
      200,
    );
  }),
);

export { adminMcpTokens };
