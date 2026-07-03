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
import {
  resolveWorkspaceRestDatasourcesOrThrow,
  RestDatasourceReconnectError,
} from "@atlas/api/lib/openapi/workspace-datasource";
import {
  validateRestOperation,
  type RestOperationPolicy,
} from "@atlas/api/lib/openapi/validate-rest-operation";
import {
  confirmRequestToParams,
  verifyRestConfirmToken,
  burnRestConfirmNonce,
} from "@atlas/api/lib/openapi/rest-write-confirm";
import { auditRestOperation, deriveRestRowCount } from "@atlas/api/lib/openapi/rest-audit";
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
  // #3007: the single-use confirm token minted at staging. Required — a confirm
  // POST without it is a malformed request (rejected by the validation hook).
  token: z.string().min(1, "confirm token is required"),
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
    400: { description: "Invalid request / no active workspace / missing-invalid-expired-replayed confirm token / not a write", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden — writes disabled for this operation", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Datasource or operation not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid parameters", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server / configuration error", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Upstream REST client/transport fault", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Datasource connected but its credential needs reconnecting before the write can run (#3030)", content: { "application/json": { schema: ErrorSchema } } },
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
        // A connected datasource's credential is unresolvable (e.g. github-data's
        // GitHub App access was revoked) — the staged write can't run until it's
        // reconnected. 503 + reconnect guidance, not a misleading 500 "retry".
        if (err instanceof RestDatasourceReconnectError) {
          log.warn(
            { orgId, operationId: input.operationId, requestId, reconnectableCount: err.reconnectableCount },
            "Confirm blocked — the workspace's REST datasource needs reconnecting",
          );
          return c.json(
            {
              error: "datasource_unavailable",
              message:
                "This workspace's REST datasource needs to be reconnected before this write can run — " +
                "reconnect it from Admin → Connections, then try again.",
              requestId,
            },
            503,
          );
        }
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

      // #3007: the single-use confirm gate. The staged write carries a server-
      // signed token binding (workspace, datasource, operation, canonical params,
      // nonce, exp). Verify it matches THIS re-resolved request before anything
      // else — a missing, forged, expired, or workspace-/op-/param-mismatched
      // token never reaches the upstream. The replay (nonce burn) check runs just
      // before dispatch. The specific failure reason is logged but never returned:
      // a uniform 400 keeps an attacker from probing which check tripped.
      const verification = verifyRestConfirmToken(input.token, {
        workspaceId: orgId,
        datasourceId: input.datasourceId,
        operationId: input.operationId,
        params,
      });
      if (!verification.ok) {
        // `no-key` is a server/operator misconfiguration (no signing key configured),
        // not an attacker-probeable token failure — surface it as a correlated 500,
        // not the neutral client 400. (Near-unreachable in practice: mint fails loud
        // on no-key, so a confirmable write can't have been staged without a key —
        // reachable only if the key is removed/rotated-to-empty between stage+confirm.)
        if (verification.reason === "no-key") {
          log.error(
            { orgId, datasource: datasource.id, operationId: input.operationId, requestId },
            "Confirm rejected: no signing key configured for confirm tokens (server misconfiguration)",
          );
          return c.json(
            {
              error: "confirm_token_unverifiable",
              message:
                "The server can't verify write confirmations right now — its confirm-token signing key isn't configured. This is a server configuration issue, not a problem with your request.",
              requestId,
            },
            500,
          );
        }
        // Every attacker-probeable reason (missing / malformed / bad-signature /
        // binding-mismatch / expired) maps to ONE neutral 400 — the specific reason
        // is logged server-side but never returned, so it can't be probed.
        log.warn(
          { orgId, datasource: datasource.id, operationId: input.operationId, reason: verification.reason, requestId },
          "Confirm rejected: invalid confirm token",
        );
        return c.json(
          {
            error: "confirm_token_invalid",
            message:
              "This write confirmation is missing, invalid, expired, or already used. Ask Atlas to retry the write so it can be re-staged.",
          },
          400,
        );
      }

      const policy: RestOperationPolicy = {
        workspaceId: orgId,
        datasourceId: datasource.id,
        writeAllowlist: datasource.writeAllowlist,
        // #3008: a config-flagged side-effecting GET must be re-gated by the
        // allowlist on the confirm replay too (the spec-extension path is already
        // covered, since `operation.sideEffecting` is read from the graph). Without
        // this, a direct confirm POST for such a GET would bypass the allowlist.
        sideEffectingOperations: datasource.sideEffectingOperations,
        // #3035: thread the candidate's read-safe POSTs so the verdict classifies
        // identically to the tool path. A demoted read-safe POST resolves to
        // `requiresConfirmation: false` here and is refused below as "not a write" —
        // the confirm endpoint fires confirmed WRITES, never reads.
        ...(datasource.readSafePostOperations !== undefined
          ? { readSafePostOperations: datasource.readSafePostOperations }
          : {}),
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
          default: {
            // Fail closed: a future RestValidationReason that isn't handled here must
            // NOT fall through toward dispatch on this security boundary.
            const _exhaustive: never = error.reason;
            log.error(
              { orgId, datasource: datasource.id, operationId: input.operationId, requestId, reason: String(_exhaustive) },
              "Confirm rejected: unhandled validation reason (fail-closed)",
            );
            return c.json(
              { error: "internal_error", message: "The write was rejected by an unhandled validation rule.", requestId },
              500,
            );
          }
        }
      }

      // #3007: keep /confirm write-only. A valid token can be minted for any
      // binding (the mint is binding-agnostic), so even a well-signed token for a
      // plain read is refused here — the confirm gate exists to fire writes the
      // human approved, not to be a general dispatch endpoint.
      if (!verdict.requiresConfirmation) {
        log.warn(
          { orgId, datasource: datasource.id, operationId: input.operationId, requestId },
          "Confirm rejected: operation is a read (confirm endpoint is write-only)",
        );
        return c.json(
          {
            error: "not_a_write",
            message: `Operation "${input.operationId}" is a read — the confirm endpoint only executes writes.`,
          },
          400,
        );
      }

      // #3007: burn the nonce — single-use. Synchronous, with no `await` between
      // verifyRestConfirmToken above and here, so two concurrent replays of the
      // same token can't both reach the upstream (the first burns it; the second
      // sees it burned and is rejected as a replay).
      if (!burnRestConfirmNonce(verification.nonce, verification.expSeconds)) {
        log.warn(
          { orgId, datasource: datasource.id, operationId: input.operationId, requestId },
          "Confirm rejected: confirm token already used (replay)",
        );
        return c.json(
          {
            error: "confirm_token_invalid",
            message: "This write confirmation was already used. Ask Atlas to retry the write so it can be re-staged.",
          },
          400,
        );
      }

      // Execute the confirmed write via the un-cached primitive (writes are
      // never cached). A non-2xx upstream is surfaced, not thrown.
      //
      // This is the real "action against the datasource" — the ONLY place an
      // allowlisted REST write actually fires — so it MUST be audited (the read
      // tool path audits its dispatches in lib/tools/rest-operation.ts). Time the
      // wall-clock around the dispatch and record the outcome to the query audit
      // log alongside the existing `log.info` breadcrumb.
      const dispatchMethod = verdict.operation.method;
      const dispatchStart = Date.now();
      try {
        const result = await executeOperation(datasource.graph, input.operationId, params, datasource.auth, {
          baseUrl: datasource.baseUrl,
          timeoutMs: verdict.timeoutMs,
          // #3029: forward the datasource's declarative quirk on the confirmed-write
          // path too — same as the read tool path (lib/tools/rest-operation.ts). A
          // candidate's required headers (Notion-Version) / query shaping (Stripe's
          // expand[]) must ride the upstream call; without this an allowlisted,
          // human-confirmed write would omit them and the vendor would reject it.
          ...(datasource.quirk ? { quirk: datasource.quirk } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });

        if (result.status >= 200 && result.status < 300) {
          log.info(
            { orgId, datasource: datasource.id, operationId: input.operationId, httpStatus: result.status, requestId },
            "Confirmed REST write executed",
          );
          auditRestOperation({
            method: dispatchMethod,
            operationId: input.operationId,
            datasourceId: datasource.id,
            baseUrl: datasource.baseUrl,
            durationMs: Date.now() - dispatchStart,
            outcome: { success: true, rowCount: deriveRestRowCount(result.body) },
          });
          return c.json({ status: "executed" as const, httpStatus: result.status, body: result.body }, 200);
        }
        const httpErrorMessage = `Upstream returned HTTP ${result.status} for "${input.operationId}".`;
        log.info(
          { orgId, datasource: datasource.id, operationId: input.operationId, httpStatus: result.status, requestId },
          "Confirmed REST write — upstream non-2xx",
        );
        auditRestOperation({
          method: dispatchMethod,
          operationId: input.operationId,
          datasourceId: datasource.id,
          baseUrl: datasource.baseUrl,
          durationMs: Date.now() - dispatchStart,
          outcome: { success: false, error: httpErrorMessage },
        });
        return c.json(
          {
            status: "http_error" as const,
            httpStatus: result.status,
            body: result.body,
            message: httpErrorMessage,
          },
          200,
        );
      } catch (err) {
        const durationMs = Date.now() - dispatchStart;
        if (err instanceof OpenApiClientError) {
          log.warn(
            { orgId, datasource: datasource.id, operationId: input.operationId, reason: err.reason, requestId },
            "Confirmed REST write client fault",
          );
          auditRestOperation({
            method: dispatchMethod,
            operationId: input.operationId,
            datasourceId: datasource.id,
            baseUrl: datasource.baseUrl,
            durationMs,
            outcome: { success: false, error: err.message },
          });
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
        auditRestOperation({
          method: dispatchMethod,
          operationId: input.operationId,
          datasourceId: datasource.id,
          baseUrl: datasource.baseUrl,
          durationMs,
          outcome: { success: false, error: message },
        });
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
