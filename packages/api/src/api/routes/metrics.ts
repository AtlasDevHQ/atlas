/**
 * Canonical metric execution over REST (#4048 / ADR-0027 shared gate-parity contract).
 *
 * POST /api/v1/metrics/{id}/run executes a canonical metric by id using the
 * metric's AUTHORITATIVE SQL (used exactly as defined in semantic/metrics/*.yml)
 * and returns the result for the bound workspace. It is the REST sibling of the
 * MCP `runMetric` tool — the `atlas metric run <id>` CLI command calls it.
 *
 * Per ADR-0027 §"shared gate-parity contract" this endpoint:
 *  - reuses the SAME gated core, never re-deriving auth — `standardAuth`
 *    resolves the workspace credential (the `atlas login` device-flow bearer)
 *    live to `{ orgId, role }`, member floor (any authenticated member; a
 *    member's metric-run reach ≡ their agent-loop reach);
 *  - runs Billing gate-0 (solvency) at the route via `checkAgentBillingGate`,
 *    parity with the MCP `runMetric` tool's `checksBilling: true` (the metric's
 *    SQL reaches a datasource). Shape B runs no LLM, so it is solvency-gated but
 *    not token-metered;
 *  - resolves the metric + group routing through the SHARED `resolveMetricRun`
 *    facade the MCP tool's routing mirrors, then runs the authoritative SQL
 *    through the SHARED `runUserQueryPipeline` — inheriting the full validation
 *    pipeline (4-layer validation → table whitelist → RLS injection →
 *    auto-LIMIT → statement timeout → audit), exactly the agent-loop discipline;
 *  - derives workspace isolation from the credential, never the request: the
 *    org comes from `reqCtx.user.activeOrganizationId`, there is no workspace
 *    field in the body, and a connection in another workspace simply isn't found;
 *  - audits `origin=cli` (from the credential's resolved origin claim) with a
 *    distinct `actor_kind` traceable to the owning member — never an anonymous
 *    passthrough.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  checkAgentBillingGate,
  type AgentBillingGateResult,
} from "@atlas/api/lib/billing/agent-gate";
import { resolveMetricRun } from "@atlas/api/lib/semantic/metric-run";
import { isRequestOrigin } from "@atlas/api/lib/approvals/types";
import { resolveActorKind } from "@atlas/api/lib/auth/api-key-metadata";
import type { UserQueryOutcome } from "@atlas/api/lib/tools/sql";
import { validationHook } from "./validation-hook";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("metrics-routes");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RunMetricRequestSchema = z
  .object({
    /**
     * Reserved filter pass-through. Empty/omitted today; a non-empty object is
     * rejected (parity with the MCP `runMetric` tool) rather than silently
     * dropped.
     */
    filters: z.record(z.string(), z.unknown()).optional(),
    /**
     * Optional explicit connection id. Omit to run the metric against its own
     * group. A connection id outside the metric's group is rejected.
     */
    connectionId: z.string().min(1).max(256).optional(),
  })
  .optional();

const RunMetricResponseSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  /**
   * Scalar value for a single-column/single-row metric, else the full row set.
   * Mirrors the MCP `runMetric` tool's `value` projection.
   */
  value: z.unknown(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  /** The authoritative SQL that was executed (used exactly as defined). */
  sql: z.string(),
  executedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const runMetricRoute = createRoute({
  method: "post",
  path: "/{id}/run",
  tags: ["Metrics"],
  summary: "Run a canonical metric",
  description:
    "Executes a canonical metric by id using the metric's authoritative SQL and returns the result for the bound workspace. Group routing is honored; the SQL runs through the same validation pipeline (whitelist → RLS → auto-LIMIT → audit) as the agent loop.",
  request: {
    params: z.object({
      id: z.string().min(1).max(256).openapi({
        param: { name: "id", in: "path" },
        example: "total_gmv",
      }),
    }),
    body: {
      content: { "application/json": { schema: RunMetricRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Metric result",
      content: { "application/json": { schema: RunMetricResponseSchema } },
    },
    400: {
      description: "Bad request (unsupported filters, wrong connection, or invalid SQL)",
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
      description: "Metric not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Approval required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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
 * The `ok` arm is handled at the call site (it shapes the metric result).
 * Exhaustive — a new outcome kind fails to compile here.
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

export const metrics = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

metrics.use(standardAuth);
metrics.use(requestContext);

metrics.openapi(runMetricRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const authResult = c.get("authResult");
      const user = authResult?.user;
      const orgId = user?.activeOrganizationId;

      const { id } = c.req.valid("param");
      // Body is optional; default to an empty object when absent.
      const body = (c.req.valid("json") ?? {}) as {
        filters?: Record<string, unknown>;
        connectionId?: string;
      };

      // --- Bound-workspace precondition. The whole surface derives isolation
      // from the credential's org (never the request), so a credential with no
      // bound workspace (a multi-workspace `atlas login` pending the picker
      // slice, ADR-0026) cannot resolve a datasource. Reject explicitly with an
      // actionable message rather than letting an `undefined` org flow into the
      // gate/pipeline and surface as a confusing downstream error. ---
      if (!orgId) {
        log.warn({ requestId, userId: user?.id }, "Metric run with no bound workspace");
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

      // --- Billing gate-0 (solvency) — parity with MCP runMetric's
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
          "Metric run blocked by billing enforcement",
        );
        return c.json(
          {
            error: gate.errorCode,
            message: gate.errorMessage,
            retryable: gate.retryable,
            ...(gate.retryAfterSeconds !== undefined && { retryAfterSeconds: gate.retryAfterSeconds }),
            requestId,
          } as never,
          // httpStatus is 403/404/429/503 — all declared in the responses map;
          // cast to one declared literal to satisfy c.json's typed overload.
          (gate.httpStatus ?? 403) as 403,
        );
      }

      // --- Resolve the metric + group routing via the shared facade. ---
      const resolution = yield* Effect.promise(() =>
        resolveMetricRun({
          id,
          ...(body.filters && { filters: body.filters }),
          ...(body.connectionId && { connectionId: body.connectionId }),
          orgId,
        }),
      );

      if (resolution.kind === "unknown_metric") {
        return c.json(
          { error: "unknown_metric", message: `Metric "${id}" not found.`, requestId },
          404,
        );
      }
      if (resolution.kind === "filters_unsupported") {
        return c.json(
          {
            error: "invalid_request",
            message:
              "Metric `filters` pass-through is not yet supported. Omit `filters` to run the metric as defined.",
            requestId,
          },
          400,
        );
      }
      if (resolution.kind === "wrong_connection") {
        return c.json(
          {
            error: "invalid_request",
            message: `Metric "${resolution.metricId}" belongs to the "${resolution.group}" group, but connectionId "${resolution.connectionId}" targets a different datasource. Omit connectionId or pass "${resolution.metricConnectionId}".`,
            requestId,
          },
          400,
        );
      }
      if (resolution.kind === "routing_unavailable") {
        // The internal-DB lookup that validates the explicit connection's group
        // membership faulted. We can't prove or disprove membership, so this is
        // a retryable server-side condition — NOT a confident wrong_connection
        // 400 (#4109). Surface it as a 503 carrying the requestId so an operator
        // sees the real fault, not a misleading user-input error.
        log.warn(
          {
            requestId,
            orgId,
            metricId: resolution.metricId,
            connectionId: resolution.connectionId,
            category: "routing_unavailable",
          },
          "Metric-run group-membership lookup degraded (internal DB fault) — returning retryable 503",
        );
        return c.json(
          {
            error: "routing_unavailable",
            message:
              "Could not verify the connection's group membership right now (a transient internal error). Please retry shortly.",
            retryable: true,
            requestId,
          } as never,
          503,
        );
      }

      const { metric, targetConnectionId } = resolution;
      const explanation = metric.description
        ? `CLI metric run ${metric.id}: ${metric.description}`
        : `CLI metric run ${metric.id}`;

      // Origin for approval-rule matching + audit: the credential's resolved
      // origin claim (`cli` for an `atlas login` device-flow bearer), falling
      // back to `cli` — this endpoint is the workspace CLI metric-run surface.
      const claimOrigin = user?.claims?.origin;
      const agentOrigin =
        typeof claimOrigin === "string" && isRequestOrigin(claimOrigin) ? claimOrigin : "cli";

      // `actor.kind` is the *who*, distinct from `origin` (the transport): a
      // human who approved a device-flow `atlas login` → `human`; an UNATTENDED
      // workspace API key (#4046 / ADR-0027 §6) → `api_key`. This metric run is
      // written to `audit_log` by `runUserQueryPipeline`, so flattening it to
      // `human` would make a leaked CI key indistinguishable from a compromised
      // human session in the trail — shared with the sibling routes via
      // `resolveActorKind`.
      const actorKind = resolveActorKind(user?.claims);

      // The outer `requestContext` middleware bound these (it ran first); we
      // re-thread them through the inner bind because `withRequestContext` is
      // `AsyncLocalStorage.run` — it REPLACES the context, it does not merge.
      // Dropping `atlasMode` would silently downgrade a developer-mode caller to
      // the published overlay inside `runUserQueryPipeline` (it reads
      // `reqCtx.atlasMode ?? "published"` for connection mode-visibility AND the
      // table whitelist scope), so a draft metric / freshly-profiled draft
      // connection would resolve against the wrong overlay.
      const atlasMode = c.get("atlasMode");
      const trustDeviceIdentifier = c.get("trustDeviceIdentifier");

      // Bind the actor + origin + mode into AsyncLocalStorage so
      // runUserQueryPipeline's RLS claims, approval matching, audit row, and
      // mode-scoped connection + whitelist resolution all see the bound caller.
      const outcome = yield* Effect.promise(() =>
        withRequestContext(
          {
            requestId,
            user,
            atlasMode,
            trustDeviceIdentifier,
            agentOrigin,
            actor: { kind: actorKind },
          },
          async () => {
            const { runUserQueryPipeline } = await import("@atlas/api/lib/tools/sql");
            return runUserQueryPipeline({
              sql: metric.sql,
              explanation,
              ...(targetConnectionId && { connectionId: targetConnectionId }),
            });
          },
        ),
      );

      if (outcome.kind !== "ok") {
        const mapped = outcomeError(outcome, requestId);
        // The OpenAPI route response is typed per-status; the mapper's body
        // shape is guaranteed by its exhaustive switch but TS can't narrow
        // across the status-set, so cast at the boundary (same pattern as
        // dashboards.ts:userQueryOutcomeToResponse → c.json).
        return c.json(mapped.body as never, mapped.status as 400);
      }

      // Single column / single row → scalar value; otherwise the full row set.
      // Mirrors the MCP runMetric tool's `value` projection.
      const value =
        outcome.columns.length === 1 && outcome.rows.length === 1
          ? outcome.rows[0][outcome.columns[0]]
          : outcome.rows;

      return c.json(
        {
          id: metric.id,
          label: metric.label,
          value,
          columns: outcome.columns,
          rows: outcome.rows,
          rowCount: outcome.rowCount,
          truncated: outcome.truncated,
          sql: metric.sql,
          executedAt: new Date().toISOString(),
        },
        200,
      );
    }),
    { label: "run metric" },
  );
});
