/**
 * Raw-SQL execution over REST (#4047 / ADR-0027, the sharpest of the ADR-0025 §3
 * missing endpoints).
 *
 * POST /api/v1/execute-sql accepts ONE caller-authored SQL string and runs it
 * through the SAME shared `runUserQueryPipeline` (`lib/tools/sql.ts`) the
 * dashboard preview / single-card refresh use — the REST-shaped sibling of the
 * agent loop, returning `{columns, rows}`. The `atlas sql "SELECT ..."` CLI
 * command calls it. This is Shape B (raw SQL): the caller writes the SQL, Atlas
 * validates + executes it (no Atlas LLM), so it is solvency-gated but not
 * token-metered.
 *
 * SQL is never sandboxed — it runs inside the customer's DB via the driver
 * pool, not on Atlas's host (ADR-0027 Context). The validation pipeline + the
 * read-only connection is therefore the SOLE security boundary, and this route
 * reaches it carrying the full discipline:
 *
 *  - 4-layer validation (regex mutation guard → AST single-SELECT → table
 *    whitelist) + auto-LIMIT + statement timeout + read-only connection — all
 *    inherited unchanged from `runUserQueryPipeline`. DML/DDL, multi-statement,
 *    non-whitelisted-table, and unparseable SQL are rejected, never silently
 *    skipped (ADR-0027 AC1, §4). There is no whitelist-skipping path: SQL
 *    datasources set no `connection.validate`, so the pipeline never takes the
 *    custom-validator branch that skips whitelist/RLS/auto-LIMIT (the regression
 *    test in `__tests__/execute-sql.test.ts` pins this).
 *  - Billing gate-0 (solvency) at the route via `checkAgentBillingGate`, parity
 *    with the MCP `executeSQL` tool's `checksBilling: true` (ADR-0027 §1). A
 *    suspended / trial-expired / plan-exhausted workspace is blocked before the
 *    pipeline runs. Solvency-only — Shape B runs no LLM. A throw from the gate
 *    fails closed to a 503 (never an allow).
 *  - Member floor (any authenticated member; inherited from `standardAuth`) and
 *    no escalation: raw-SQL reach ≡ agent-loop reach for the same member —
 *    identical whitelist, RLS, and approval classification (the pipeline derives
 *    `tablesAccessed`/`columnsAccessed` from the AST, so approval rules fire on
 *    raw SQL exactly as on agent SQL) (ADR-0027 §2).
 *  - RLS fail-closed: `runUserQueryPipeline` applies `applyRLSEffect` with the
 *    acting member's claims; RLS enabled + no usable claim → block, never
 *    claim-less rows (ADR-0027 §3).
 *  - Workspace isolation derives from the credential, never the request: the org
 *    comes from `getRequestContext().user.activeOrganizationId` inside the
 *    pipeline; the body carries ONLY `{ sql, connectionId? }` — no org /
 *    workspace / connection-owner field. A `connectionId` from another workspace
 *    simply isn't found → `connection_unavailable` (ADR-0027 §5).
 *  - Audited with a credential-derived origin (`cli` for a device-flow `atlas`
 *    bearer; left undefined for a non-CLI session, never mislabeled) + a distinct
 *    `actor_kind` traceable to the owning member: the handler binds `agentOrigin`
 *    (derived from the credential's `origin` claim, NOT hardcoded) + an
 *    `actor.kind` of `api_key` for an unattended workspace key (#4046) or `human`
 *    otherwise, so the audit row written by the pipeline distinguishes a leaked
 *    CI key from the real member who minted a device-flow login (ADR-0027 §6).
 *  - Rate limit reuses the standard per-identity bucket (inherited from
 *    `standardAuth`); per-workspace pool + auto-LIMIT + statement timeout bound
 *    the blast radius (ADR-0027 §7).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  checkAgentBillingGate,
  type AgentBillingGateResult,
} from "@atlas/api/lib/billing/agent-gate";
import { isRequestOrigin } from "@atlas/api/lib/approvals/types";
import { resolveActorKind } from "@atlas/api/lib/auth/api-key-metadata";
import type { UserQueryOutcome } from "@atlas/api/lib/tools/sql";
import { validationHook } from "./validation-hook";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("execute-sql-route");

/**
 * Upper bound on a single SQL string. Generous for any realistic analytical
 * SELECT (deep CTE stacks, long IN lists) while capping the payload a hostile
 * client can force through the parser. Tunable if a real need surfaces.
 */
const MAX_SQL_LEN = 100_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ExecuteSqlRequestSchema = z.object({
  /** The caller-authored SQL string. ONE validated SELECT; everything else is rejected. */
  sql: z
    .string()
    .trim()
    .min(1, "sql must not be empty")
    .max(MAX_SQL_LEN, `sql must be at most ${MAX_SQL_LEN} characters`),
  /**
   * Optional explicit datasource connection id. Omit to run against the
   * workspace's default datasource. A connection id in another workspace simply
   * isn't found (workspace isolation derives from the credential — there is NO
   * org/workspace/owner field here a caller could spoof).
   */
  connectionId: z.string().min(1).max(256).optional(),
});

const ExecuteSqlResponseSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  /** True when the result hit the auto-LIMIT row cap (more rows exist upstream). */
  truncated: z.boolean(),
  executionMs: z.number(),
  executedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const executeSqlRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["SQL"],
  summary: "Run a validated SELECT",
  description:
    "Runs ONE caller-authored SELECT through the full validation pipeline (4-layer validation → table whitelist → RLS injection → auto-LIMIT → statement timeout → audit) against a read-only connection and returns {columns, rows}. DML/DDL, multi-statement, non-whitelisted-table, and unparseable SQL are rejected. The advanced surface — the NL `atlas query` path is the recommended happy path.",
  request: {
    body: {
      content: { "application/json": { schema: ExecuteSqlRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Query result",
      content: { "application/json": { schema: ExecuteSqlResponseSchema } },
    },
    400: {
      description: "Bad request (rejected/invalid SQL, no bound workspace, or malformed body)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — billing block or RLS-denied",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Workspace not found (billing block — deleted workspace)",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    409: {
      description: "Approval required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limited or throttled",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "Datasource or enterprise subsystem unavailable",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Outcome → HTTP mapping
// ---------------------------------------------------------------------------

/** The status codes `outcomeError` can produce — all declared in the route's responses map. */
type MappedStatus = 400 | 401 | 403 | 409 | 429 | 500 | 503;
type MappedResponse = { body: Record<string, unknown>; status: MappedStatus };

/**
 * Map a {@link UserQueryOutcome} (non-`ok`) onto the Atlas error envelope.
 * The `ok` arm is handled at the call site (it shapes the query result).
 * Exhaustive — a new outcome kind fails to compile here. Mirrors the sibling
 * metrics route (#4048) so the two raw-datasource surfaces stay symmetric.
 */
function outcomeError(
  outcome: Exclude<UserQueryOutcome, { kind: "ok" }>,
  requestId: string,
): MappedResponse {
  switch (outcome.kind) {
    case "validation_failed":
      return { body: { error: "invalid_sql", message: outcome.message, requestId }, status: 400 };
    case "plugin_rejected":
      return { body: { error: "plugin_rejected", message: outcome.message, requestId }, status: 400 };
    case "query_failed":
      return { body: { error: "query_failed", message: outcome.message, requestId }, status: 400 };
    case "rls_failed":
      return { body: { error: "rls_blocked", message: outcome.message, requestId }, status: 403 };
    case "approval_required":
      return {
        body: {
          error: "approval_required",
          approvalRequestId: outcome.approvalRequestId,
          matchedRules: outcome.matchedRules,
          message: outcome.message,
          requestId,
        },
        status: 409,
      };
    case "approval_identity_missing":
      return { body: { error: "auth_required", message: outcome.message, requestId }, status: 401 };
    case "approval_unavailable":
      return { body: { error: "approval_unavailable", message: outcome.message, requestId }, status: 503 };
    case "rate_limited":
      return {
        body: {
          error: "rate_limited",
          message: outcome.message,
          ...(outcome.retryAfterMs != null && { retryAfterMs: outcome.retryAfterMs }),
          requestId,
        },
        status: 429,
      };
    case "concurrency_limited":
      return { body: { error: "concurrency_limited", message: outcome.message, requestId }, status: 429 };
    case "connection_unavailable":
      return {
        body: {
          error: "connection_unavailable",
          message: outcome.message,
          connectionId: outcome.connectionId,
          requestId,
        },
        status: 503,
      };
    case "no_datasource":
      return { body: { error: "no_datasource", message: outcome.message, requestId }, status: 503 };
    case "pool_exhausted":
      return { body: { error: "pool_exhausted", message: outcome.message, requestId }, status: 503 };
    case "enterprise_unavailable":
      return { body: { error: "enterprise_load_failed", message: outcome.message, requestId }, status: 503 };
    default: {
      const _exhaustive: never = outcome;
      return {
        body: { error: "internal_error", message: `Unhandled outcome: ${(_exhaustive as { kind: string }).kind}`, requestId },
        status: 500,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const executeSql = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

executeSql.use(standardAuth);
executeSql.use(requestContext);

// Normalize JSON parse errors from @hono/zod-openapi into the standard API
// error format. Mirrors validate-sql.ts / query.ts / explore.ts.
executeSql.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

executeSql.openapi(executeSqlRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const authResult = c.get("authResult");
      const user = authResult?.user;
      const orgId = user?.activeOrganizationId;
      // The outer `requestContext` middleware bound these (it ran first); we
      // re-thread them through the inner bind below because `withRequestContext`
      // is `AsyncLocalStorage.run` — it REPLACES the context, it does not merge.
      // Dropping `atlasMode` would silently downgrade a developer-mode caller to
      // the published overlay inside `runUserQueryPipeline` (it reads
      // `reqCtx.atlasMode ?? "published"` for connection mode-visibility AND the
      // table whitelist scope).
      const atlasMode = c.get("atlasMode");
      const trustDeviceIdentifier = c.get("trustDeviceIdentifier");

      const { sql, connectionId } = c.req.valid("json");

      // --- Bound-workspace precondition. The whole surface derives isolation
      // from the credential's org (never the request), so a credential with no
      // bound workspace (a multi-workspace `atlas login` pending the picker,
      // ADR-0026) cannot resolve a datasource. Reject explicitly with an
      // actionable message rather than letting an `undefined` org flow into the
      // gate/pipeline and surface as a confusing downstream error. ---
      if (!orgId) {
        log.warn({ requestId, userId: user?.id }, "Execute-SQL with no bound workspace");
        return c.json(
          {
            error: "bad_request",
            message:
              "Your login is not bound to a workspace. Single-workspace accounts bind automatically; in-flow workspace selection for multi-workspace accounts is coming soon (ADR-0026).",
            requestId,
          },
          400,
        );
      }

      // --- Billing gate-0 (solvency) — parity with MCP executeSQL's
      // checksBilling. Reaches a datasource, so a suspended / trial-expired /
      // plan-exhausted workspace is blocked before the SQL runs. Solvency-only:
      // Shape B runs no LLM, so nothing is token-metered. An unexpected throw
      // from the gate is mapped to a fail-closed 503 (never an allow), keeping
      // the billing surface's "try again" signal instead of an opaque 500. ---
      const gate = yield* Effect.tryPromise({
        try: () => checkAgentBillingGate(orgId),
        catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((err) => {
          log.error(
            { requestId, orgId, err, category: "billing_check_error" },
            "Billing gate threw — failing closed",
          );
          const failClosed: AgentBillingGateResult = {
            allowed: false,
            errorCode: "billing_check_failed",
            errorMessage: "Unable to verify billing status. Please try again shortly.",
            httpStatus: 503,
            retryable: true,
          };
          return Effect.succeed(failClosed);
        }),
      );
      if (!gate.allowed) {
        log.warn(
          { requestId, orgId, errorCode: gate.errorCode, category: "billing_blocked" },
          "Execute-SQL blocked by billing enforcement",
        );
        return c.json(
          {
            error: gate.errorCode,
            message: gate.errorMessage,
            retryable: gate.retryable,
            ...(gate.retryAfterSeconds !== undefined && { retryAfterSeconds: gate.retryAfterSeconds }),
            requestId,
          } as never,
          // httpStatus is 403/404/429/503 — all declared in the responses map.
          // 404 (deleted workspace, `workspace_deleted`) must NOT be coerced to
          // 403: the CLI client maps 404 → an actionable "workspace no longer
          // exists" message distinct from a billing/RLS 403. Cast to one declared
          // literal only to satisfy c.json's typed overload; the runtime status is
          // the gate's own.
          (gate.httpStatus ?? 403) as 403,
        );
      }

      // Audit origin derives from the credential's claim, never hardcoded — a
      // device-flow `atlas` bearer AND a workspace API key both carry
      // `origin: "cli"` (the CLI transport; #4043 / ADR-0026 / #4046); a web
      // session leaves it undefined so it is not mislabeled. Validated against the
      // canonical vocabulary so an unexpected value can't land in the
      // approval/audit context.
      const claimsOrigin = user?.claims?.origin;
      const agentOrigin =
        typeof claimsOrigin === "string" && isRequestOrigin(claimsOrigin) ? claimsOrigin : undefined;

      // `actor.kind` is the *who*, distinct from the *transport* (`origin`): a
      // human who approved a device-flow `atlas login` in a browser → `human`; an
      // UNATTENDED workspace API key (#4046 / ADR-0027 §6) → `api_key`, so a
      // leaked CI key vs a compromised human session are distinguishable in the
      // audit trail. Shared with the sibling CLI routes (metrics/explore/
      // datasources) via `resolveActorKind` so the marker — stamped on the
      // resolved user by the api-key auth path (`managed.ts` → `claims.api_key`)
      // — is read consistently across the whole surface a key can reach.
      const actorKind = resolveActorKind(user?.claims);

      // Re-establish the request context as a SUPERSET of the middleware's bind
      // (`user` + `atlasMode` + `trustDeviceIdentifier`) PLUS the audit origin +
      // a distinct actor kind, so `runUserQueryPipeline`'s RLS claims, approval
      // matching, and audit row all see the bound caller AND resolve the correct
      // org-scoped, mode-specific connection + whitelist.
      const outcome = yield* Effect.promise(() =>
        withRequestContext(
          {
            requestId,
            user,
            atlasMode,
            trustDeviceIdentifier,
            actor: { kind: actorKind },
            ...(agentOrigin ? { agentOrigin } : {}),
          },
          async () => {
            const { runUserQueryPipeline } = await import("@atlas/api/lib/tools/sql");
            return runUserQueryPipeline({
              sql,
              explanation: "CLI raw SQL execution",
              ...(connectionId && { connectionId }),
            });
          },
        ),
      );

      if (outcome.kind !== "ok") {
        const mapped = outcomeError(outcome, requestId);
        // The OpenAPI route response is typed per-status; the mapper's body
        // shape is guaranteed by its exhaustive switch but TS can't narrow
        // across the status-set, so cast at the boundary (same pattern as the
        // sibling metrics route).
        return c.json(mapped.body as never, mapped.status as 400);
      }

      return c.json(
        {
          columns: outcome.columns,
          rows: outcome.rows,
          rowCount: outcome.rowCount,
          truncated: outcome.truncated,
          executionMs: outcome.executionMs,
          executedAt: new Date().toISOString(),
        },
        200,
      );
    }),
    { label: "execute sql" },
  );
});
