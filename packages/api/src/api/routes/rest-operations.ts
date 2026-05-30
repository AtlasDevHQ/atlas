/**
 * REST datasource operation routes (PRD #2868 slice 5, #2929).
 *
 * `POST /api/v1/rest-operations/confirm` is the confirm-before-write execution
 * point: the ONLY place an allowlisted REST write actually fires. The
 * `executeRestOperation` agent tool never dispatches a write — it returns a
 * `needs_confirmation` result, the chat surface renders a confirm-before-write
 * banner, and the banner POSTs the staged payload here after the human confirms.
 *
 * This endpoint is NOT a trusted fast-path. It re-resolves the caller's
 * workspace datasources and re-runs {@link validateRestOperation} server-side
 * (dispatch mode) — so a tampered client payload still can't escalate past the
 * admin-configured `write_allowlist`, the parameter shape, the per-operation
 * rate limit, or the timeout cap. The write executes via the un-cached
 * {@link executeOperation} primitive, so writes are never written to any cache.
 *
 * Middleware mirrors validate-sql.ts: standardAuth → requestContext.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { createLogger } from "@atlas/api/lib/logger";
import { executeOperation } from "@atlas/api/lib/openapi/client";
import { OpenApiClientError } from "@atlas/api/lib/openapi/types";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import { resolveWorkspaceRestDatasourcesOrThrow } from "@atlas/api/lib/openapi/workspace-datasource";
import {
  validateRestOperation,
  type RestOperationPolicy,
} from "@atlas/api/lib/openapi/validate-rest-operation";
import { confirmRequestToParams } from "@atlas/api/lib/openapi/rest-write-confirm";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("rest-operations");

const queryScalar = z.union([z.string(), z.number(), z.boolean()]);

const ConfirmRequestSchema = z.object({
  datasourceId: z.string().min(1, "datasourceId must not be empty"),
  operationId: z.string().min(1, "operationId must not be empty"),
  pathParams: z.record(z.string(), queryScalar).optional(),
  query: z.record(z.string(), z.union([queryScalar, z.array(queryScalar)])).optional(),
  header: z.record(z.string(), queryScalar).optional(),
  body: z.unknown().optional(),
});

const ConfirmResponseSchema = z.object({
  status: z.enum(["executed", "http_error"]),
  httpStatus: z.number(),
  body: z.unknown(),
  message: z.string().optional(),
});

/** Dependencies, injectable for tests (avoids DB + live fetch). */
export interface RestOperationsDeps {
  /** Resolve a workspace's installed REST datasources. Defaults to the DB resolver. */
  readonly resolveDatasources?: (workspaceId: string) => Promise<ReadonlyArray<RestDatasource>>;
  /** `fetch` override threaded into the slice-0 client (tests). */
  readonly fetchImpl?: typeof globalThis.fetch;
}

const confirmRoute = createRoute({
  method: "post",
  path: "/confirm",
  tags: ["REST Datasources"],
  summary: "Execute a confirmed REST write",
  description:
    "Executes a previously-staged REST write after the user confirms it in the chat surface. " +
    "Re-validates the operation against the datasource's write allowlist, parameter shape, rate " +
    "limit, and timeout cap before dispatching. Writes are never cached.",
  request: {
    body: {
      content: { "application/json": { schema: ConfirmRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Write executed (or upstream returned a non-2xx, surfaced as http_error)",
      content: { "application/json": { schema: ConfirmResponseSchema } },
    },
    400: { description: "Invalid request / no active workspace", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — writes disabled for this operation", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Datasource or operation not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid parameters", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server / configuration error", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Upstream REST client/transport fault", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/**
 * Build the rest-operations route. The factory takes a `deps` seam so route
 * tests inject a fixture resolver + a `fetch` against a mock server, instead of
 * `mock.module()`-ing the DB. `index.ts` registers the no-arg default.
 */
export function createRestOperationsRoute(deps: RestOperationsDeps = {}) {
  // Strict resolver: a registry load failure propagates so we return a correlated
  // 500 instead of a misleading 404 "datasource_not_found" (#2929 review).
  const resolveDatasources = deps.resolveDatasources ?? resolveWorkspaceRestDatasourcesOrThrow;

  const route = new OpenAPIHono<AuthEnv>();
  route.use(standardAuth);
  route.use(requestContext);

  // Match validate-sql.ts: normalize unparseable-JSON 400s into the standard
  // API error envelope rather than Hono's default text body.
  route.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
      if (err.status === 400) {
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
    }
    throw err;
  });

  route.openapi(
    confirmRoute,
    async (c) => {
      const auth = c.get("authResult");
      const requestId = c.get("requestId");
      const orgId = auth?.user?.activeOrganizationId;
      if (!orgId) {
        return c.json(
          { error: "no_workspace", message: "No active workspace — select one before confirming a write." },
          400,
        );
      }

      const input = c.req.valid("json");

      let datasources: ReadonlyArray<RestDatasource>;
      try {
        datasources = await resolveDatasources(orgId);
      } catch (err) {
        // The registry load failed (DB outage). Return a correlated 500 rather
        // than letting the throw escape to the global handler (which would mint a
        // fresh, log-unrelated requestId) or masquerade as a 404 not-found.
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { orgId, operationId: input.operationId, err: message, requestId },
          "Confirm could not load the workspace's REST datasources",
        );
        return c.json(
          {
            error: "datasource_unavailable",
            message: "Couldn't load this workspace's REST datasources right now. Retry shortly.",
            requestId,
          },
          500,
        );
      }
      const datasource = datasources.find((d) => d.id === input.datasourceId);
      if (!datasource) {
        return c.json(
          { error: "datasource_not_found", message: `No connected REST datasource has id "${input.datasourceId}".` },
          404,
        );
      }

      const params = confirmRequestToParams(input);
      const policy: RestOperationPolicy = {
        workspaceId: orgId,
        datasourceId: datasource.id,
        writeAllowlist: datasource.writeAllowlist,
        dispatch: true, // this IS the upstream call — debit the quota
        ...(datasource.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: datasource.rateLimitPerMinute }
          : {}),
        ...(datasource.requestTimeoutMs !== undefined
          ? { requestedTimeoutMs: datasource.requestTimeoutMs }
          : {}),
      };

      const verdict = validateRestOperation(datasource.graph, input.operationId, params, policy);
      if (!verdict.allowed) {
        const { error } = verdict;
        switch (error.reason) {
          case "unknown-operation":
            return c.json({ error: "unknown_operation", message: error.message }, 404);
          case "writes-disabled":
            log.warn(
              { orgId, datasource: datasource.id, operationId: input.operationId, requestId },
              "Confirm rejected: operation not in write allowlist",
            );
            return c.json({ error: "writes_disabled", message: error.message }, 403);
          case "invalid-params":
            return c.json({ error: "invalid_params", message: error.message }, 422);
          case "rate-limit-exceeded":
            if (error.retryAfterMs !== undefined) {
              c.header("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
            }
            return c.json({ error: "rate_limited", message: error.message }, 429);
          case "timeout-exceeded":
            log.warn(
              { orgId, datasource: datasource.id, operationId: input.operationId, requestId },
              "Confirm rejected: per-install request timeout is misconfigured (outside the cap)",
            );
            return c.json({ error: "timeout_misconfigured", message: error.message, requestId }, 500);
        }
      }

      // Execute the confirmed write via the un-cached primitive (writes are
      // never cached). A non-2xx upstream is surfaced, not thrown.
      try {
        const result = await executeOperation(datasource.graph, input.operationId, params, datasource.auth, {
          baseUrl: datasource.baseUrl,
          timeoutMs: verdict.timeoutMs,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });

        if (result.status >= 200 && result.status < 300) {
          log.info(
            { orgId, datasource: datasource.id, operationId: input.operationId, httpStatus: result.status, requestId },
            "Confirmed REST write executed",
          );
          return c.json({ status: "executed" as const, httpStatus: result.status, body: result.body }, 200);
        }
        log.info(
          { orgId, datasource: datasource.id, operationId: input.operationId, httpStatus: result.status, requestId },
          "Confirmed REST write — upstream non-2xx",
        );
        return c.json(
          {
            status: "http_error" as const,
            httpStatus: result.status,
            body: result.body,
            message: `Upstream returned HTTP ${result.status} for "${input.operationId}".`,
          },
          200,
        );
      } catch (err) {
        if (err instanceof OpenApiClientError) {
          log.warn(
            { orgId, datasource: datasource.id, operationId: input.operationId, reason: err.reason, requestId },
            "Confirmed REST write client fault",
          );
          return c.json(
            { error: "rest_client_error", message: err.message, requestId },
            502,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { orgId, datasource: datasource.id, operationId: input.operationId, err: message, requestId },
          "Confirmed REST write unexpected failure",
        );
        return c.json({ error: "internal_error", message: "Failed to execute the write.", requestId }, 500);
      }
    },
    (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
          422,
        );
      }
    },
  );

  return route;
}

/** The default route registered by `index.ts`. */
export const restOperations = createRestOperationsRoute();
