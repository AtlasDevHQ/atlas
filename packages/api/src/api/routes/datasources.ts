/**
 * Datasource profiling over REST (#4052 / ADR-0025 §3 missing endpoint #4,
 * governed by ADR-0027's shared gate-parity contract; the profiler seam is
 * ADR-0017 / #3667).
 *
 * POST /api/v1/datasources/{id}/profile introspects a registered datasource and
 * GENERATES its semantic layer — the SaaS analog of `atlas init`, and the REST
 * sibling of the MCP `profile_datasource` tool. It reuses the SAME shared
 * profiler facade (`resolveLiveConnection` → `profileLiveDatasource`) the MCP
 * tool reaches, so every transport (native pg/mysql, url/config plugins, OAuth)
 * is profilable by construction. The `atlas datasource profile <id>` CLI command
 * calls it.
 *
 * Generated entities land as DRAFTS (content mode, status='draft') — never
 * auto-published. They are queryable in developer mode immediately and go live
 * to the published `/chat` surface only via the admin publish flow. This is the
 * origin-ceiling rule: a CLI/agent surface may provision/raise, never publish.
 *
 * Per ADR-0027's shared gate-parity contract + the issue's grill follow-through:
 *   - ADMIN floor (NOT member). Profiling PERSISTS semantic-layer drafts — a
 *     configuration action — so it aligns with the org-admin floor the existing
 *     admin-connection routes assume (ADR-0025 §41). Enforced by `adminAuth`.
 *   - Billing gate-0 (solvency), parity with the MCP tool's `checksBilling: true`
 *     (it reaches the datasource to introspect). An insolvent workspace is blocked
 *     BEFORE the connection is resolved; an unexpected throw fails CLOSED to 503.
 *   - Workspace isolation derives from the CREDENTIAL, never the request: the org
 *     comes from `authResult.user.activeOrganizationId`; there is no workspace
 *     field in the body, and a datasource in another workspace simply isn't found.
 *   - Audited `origin=cli` (from the credential's resolved origin claim) +
 *     `actor.kind=human` (the device-flow login is a person), bound into the
 *     request context so any approval/audit path traces to the owning member.
 *
 * ── Long-running, streamed, cancellable ───────────────────────────────
 * Profiling a real datasource is long-running, so the route does NOT buffer a
 * single JSON response (which would hang the CLI silently for minutes). Once the
 * connection resolves it returns 200 and STREAMS newline-delimited JSON
 * (`application/x-ndjson`): a `start` event, one `table` event per profiled
 * table, then a terminal `result` (or `error`) event. The CLI renders progress
 * live from these events.
 *
 * Because the stream has already committed a 200 by the time profiling runs, a
 * profiling FAILURE (no tables, too many errors, a stale OAuth token revoked
 * mid-profile, or an unexpected throw) rides as a terminal `error` event in the
 * NDJSON body — never an HTTP 5xx mid-stream (the status line is already sent).
 * Only failures BEFORE the stream starts (auth, billing, connection resolution)
 * map to HTTP status codes.
 *
 * Cancellation is cooperative: the request's abort signal (the CLI closing the
 * connection on Ctrl-C) is threaded into the progress bridge, whose
 * `onTableStart` throws an `OperationCancelledError` once aborted — the same
 * mechanism the MCP tool uses. The error's `name` is matched by name inside
 * `SemanticGenerator` (it lives in `@atlas/api`, which can't import the MCP
 * class) to route the cancel to a defect rather than a spurious
 * `ProfilingFailedError`; the facade re-throws the original instance, which the
 * stream loop recognizes and treats as a clean stop (no terminal event emitted).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  checkAgentBillingGate,
  type AgentBillingGateResult,
} from "@atlas/api/lib/billing/agent-gate";
import { isRequestOrigin } from "@atlas/api/lib/approvals/types";
import type { ProfileProgressCallbacks } from "@atlas/api/lib/profiler";
import { validationHook } from "./validation-hook";
import { ErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("datasources-routes");

/**
 * Cooperative-cancellation signal raised from the progress bridge when the
 * client aborts the request mid-profile. The profiler has no native
 * `AbortSignal`, so cancellation rides on the progress callback throwing.
 *
 * The `name` is EXACTLY `"OperationCancelledError"` because that is the string
 * `SemanticGenerator` matches on (`semantic-generator.ts` — `err.name ===
 * "OperationCancelledError"`) to route a cancellation to a DEFECT instead of
 * wrapping it as a spurious `ProfilingFailedError`. `profileLiveDatasource` then
 * re-throws the ORIGINAL error object (via `causeToError`), so the exact instance
 * thrown here flows back and `instanceof` matches in the stream loop's catch.
 * Get the name wrong and a Ctrl-C would silently surface as a `profiling_failed`
 * terminal event instead of a clean cancel. Mirrors the MCP
 * `OperationCancelledError` (packages/mcp/src/progress.ts), reproduced here
 * because `@atlas/api` must not import `@atlas/mcp` (ADR-0013 / core→plugin
 * decoupling).
 */
class OperationCancelledError extends Error {
  override readonly name = "OperationCancelledError";
  constructor() {
    super("Profiling was cancelled by the client.");
  }
}

// ---------------------------------------------------------------------------
// Schemas (OpenAPI documents the NDJSON stream as a string body)
// ---------------------------------------------------------------------------

const ProfileResponseSchema = z.object({}).openapi("DatasourceProfileStream", {
  description:
    "A newline-delimited JSON (application/x-ndjson) stream. Each line is a JSON object with a `type` discriminator: `start` ({ total }), `table` ({ name, index, total, status: done|error, error? }), and a terminal `result` ({ id, queryable, persisted, persistedStatus?, entitiesGenerated, metricsGenerated, tables[], profilingErrors, incomplete, incompleteTables?, elapsedMs }) or `error` ({ error, message }).",
  type: "string",
});

const profileRoute = createRoute({
  method: "post",
  path: "/{id}/profile",
  tags: ["Datasources"],
  summary: "Profile a datasource and generate its semantic layer (drafts)",
  description:
    "Introspects a registered datasource and generates its semantic layer as DRAFTS (content mode — not auto-published). Long-running: streams per-table progress as newline-delimited JSON (application/x-ndjson) so the run never hangs and stays cancellable. Requires the workspace admin role.",
  request: {
    params: z.object({
      id: z.string().min(1).max(256).openapi({
        param: { name: "id", in: "path" },
        example: "prod-us",
      }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              /** Optional profiling schema/database/dataset override. Omit for the connection's default. */
              schema: z.string().min(1).max(256).optional(),
            })
            .optional(),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: "NDJSON stream of profiling progress and the terminal result",
      content: { "application/x-ndjson": { schema: ProfileResponseSchema } },
    },
    400: {
      description: "Bad request (no bound workspace, or unsupported datasource type)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — admin role required or billing block",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Datasource not found in this workspace",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "The datasource needs to be reconnected before it can be profiled",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limited",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "Billing subsystem unavailable (fail-closed)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const datasources = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

datasources.use(adminAuth);
datasources.use(requestContext);

// Normalize JSON parse errors into the standard API error format (mirrors explore.ts).
datasources.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

datasources.openapi(profileRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");
  const user = authResult?.user;
  const orgId = user?.activeOrganizationId;
  const atlasMode = c.get("atlasMode");
  const trustDeviceIdentifier = c.get("trustDeviceIdentifier");

  const { id } = c.req.valid("param");
  const body = (c.req.valid("json") ?? {}) as { schema?: string };

  // --- Bound-workspace precondition. The surface derives isolation from the
  // credential's org (never the request), so a credential with no bound
  // workspace cannot resolve a datasource. Reject explicitly. ---
  if (!orgId) {
    log.warn({ requestId, userId: user?.id }, "Profile with no bound workspace");
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

  // --- Billing gate-0 (solvency) — parity with the MCP tool's checksBilling.
  // Profiling reaches the datasource to introspect, so a suspended /
  // trial-expired / plan-exhausted workspace is blocked before the connection
  // is resolved. An unexpected throw fails CLOSED to 503 (never an allow). ---
  let gate: AgentBillingGateResult;
  try {
    gate = await checkAgentBillingGate(orgId);
  } catch (err) {
    log.error(
      {
        requestId,
        orgId,
        err: err instanceof Error ? err : new Error(String(err)),
        category: "billing_check_error",
      },
      "Billing gate threw — failing closed",
    );
    return c.json(
      {
        error: "billing_check_failed",
        message: "Unable to verify billing status. Please try again shortly.",
        retryable: true,
        requestId,
      },
      503,
    );
  }
  if (!gate.allowed) {
    log.warn(
      { requestId, orgId, errorCode: gate.errorCode, category: "billing_blocked" },
      "Profile blocked by billing enforcement",
    );
    return c.json(
      {
        error: gate.errorCode,
        message: gate.errorMessage,
        retryable: gate.retryable,
        ...(gate.retryAfterSeconds !== undefined && { retryAfterSeconds: gate.retryAfterSeconds }),
        requestId,
      } as never,
      (gate.httpStatus ?? 403) as 403,
    );
  }

  // --- Resolve the live connection (the ONE resolver — #3667). This happens
  // BEFORE the stream commits, so its non-ok outcomes map to HTTP status codes;
  // once the stream starts, every failure rides as a terminal NDJSON event. ---
  const { resolveLiveConnection, profileLiveDatasource } = await import(
    "@atlas/api/lib/datasources/mcp-lifecycle"
  );
  const resolved = await resolveLiveConnection(orgId, id);
  if (resolved.kind === "not_found") {
    return c.json(
      {
        error: "not_found",
        message: `Datasource "${id}" not found in this workspace. Run \`atlas datasource list\` to see configured datasources.`,
        requestId,
      },
      404,
    );
  }
  if (resolved.kind === "unsupported") {
    return c.json({ error: "unsupported", message: resolved.message, requestId }, 400);
  }
  if (resolved.kind === "reconnect_required") {
    return c.json({ error: "reconnect_required", message: resolved.message, requestId }, 409);
  }

  const connection = resolved.connection;

  // Audit origin derives from the credential's claim, never hardcoded — a
  // device-flow `atlas` bearer carries `origin: "cli"`. Falls back to `cli`:
  // this IS the workspace CLI profiling surface.
  const claimOrigin = user?.claims?.origin;
  const agentOrigin =
    typeof claimOrigin === "string" && isRequestOrigin(claimOrigin) ? claimOrigin : "cli";

  // --- Stream NDJSON. The progress bridge writes a line per profiler callback;
  // the profiler runs inside the bound request context (origin=cli + actor.kind)
  // so its draft-persist + any approval/audit path traces to the owning member. ---
  const encoder = new TextEncoder();
  const requestSignal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // intentionally ignored: the consumer closed the stream (Ctrl-C). The
          // cancellation path below tears down the profile; a write after close
          // is a no-op, not a failure to surface.
          closed = true;
        }
      };

      // Progress bridge: profiler callbacks → NDJSON `start`/`table` lines.
      // `onTableStart` throws once the request is aborted so the profiler's
      // cooperative-cancellation path unwinds (mirrors the MCP progress bridge).
      const progress: ProfileProgressCallbacks = {
        onStart: (total) => write({ type: "start", total }),
        onTableStart: () => {
          if (requestSignal?.aborted) throw new OperationCancelledError();
        },
        onTableDone: (name, index, total) =>
          write({ type: "table", name, index, total, status: "done" }),
        onTableError: (name, error, index, total) =>
          write({ type: "table", name, index, total, status: "error", error }),
        onComplete: () => {},
      };

      try {
        const outcome = await withRequestContext(
          {
            requestId,
            user,
            atlasMode,
            trustDeviceIdentifier,
            actor: { kind: "human" },
            agentOrigin,
          },
          () =>
            profileLiveDatasource({
              connection,
              connectionId: id,
              // #3546 — persist the generated layer to the org store as DRAFTS
              // so the whitelist survives a restart and is visible to the API
              // process (web `/chat`), not just this request.
              orgId,
              ...(body.schema !== undefined ? { schema: body.schema } : {}),
              progress,
            }),
        );

        if (outcome.kind === "reconnect_required") {
          // An OAuth token revoked mid-profile, after the connection resolved.
          // The stream is already open, so surface the reconnect prompt as a
          // terminal error event rather than a (now-impossible) HTTP status.
          // Carry the requestId so a bug report stays log-correlatable, parity
          // with the unexpected-throw branch below.
          write({ type: "error", error: "reconnect_required", message: outcome.message, requestId });
        } else if (outcome.kind === "error") {
          // Tagged ProfilingFailedError — an actionable validation outcome (no
          // tables, too many failures, persist failure), not a server defect.
          write({ type: "error", error: "profiling_failed", message: outcome.message, requestId });
        } else {
          const r = outcome.result;
          const tables = r.entities.map((e) => e.table);
          const persisted = outcome.persisted !== null;
          const incomplete = r.errors.length > 0;
          write({
            type: "result",
            id,
            queryable: true,
            persisted,
            ...(persisted ? { persistedStatus: "draft" } : {}),
            entitiesGenerated: r.entities.length,
            metricsGenerated: r.metrics.length,
            tables,
            profilingErrors: r.errors.length,
            // Honest partial-success signal: some tables failed introspection
            // but stayed under the fatal threshold, so the layer persisted with
            // those tables ABSENT. Name them so the CLI can tell the user
            // exactly what is missing (errors are DSN-scrubbed upstream).
            incomplete,
            ...(incomplete ? { incompleteTables: r.errors.map((e) => e.table) } : {}),
            elapsedMs: r.elapsedMs,
          });
        }
      } catch (err) {
        // Cooperative cancellation: the client aborted. `onTableStart` threw the
        // OperationCancelledError instance above; SemanticGenerator routed it to a
        // defect (by name) and `profileLiveDatasource` re-threw the SAME instance,
        // so `instanceof` matches here. Also match by name as a belt-and-braces
        // guard in case the identity is lost across a future facade change — a
        // cancel must never be mislabeled as an internal error. Don't emit a
        // result; the consumer is gone, so a write would be a no-op anyway.
        if (
          err instanceof OperationCancelledError ||
          (err instanceof Error && err.name === "OperationCancelledError")
        ) {
          log.info({ requestId, orgId, datasourceId: id }, "Profile cancelled by client");
        } else {
          // An unexpected throw from the profiler. The stream has already
          // committed 200, so surface a terminal error event with a correlation
          // id rather than a (now-impossible) HTTP 500 — never a silent failure.
          log.error(
            {
              requestId,
              orgId,
              datasourceId: id,
              err: err instanceof Error ? err : new Error(String(err)),
            },
            "Datasource profile failed unexpectedly",
          );
          write({
            type: "error",
            error: "internal_error",
            message: `An unexpected error occurred while profiling (ref: ${requestId.slice(0, 8)}). If this persists, check the server logs.`,
            requestId,
          });
        }
      } finally {
        // We own the connection lifecycle — close it once profiling settles. A
        // throwaway plugin connection is torn down; a registry/OAuth connection
        // close is a no-op. Best-effort: a close failure must not crash the
        // stream teardown.
        await connection.close().catch((closeErr: unknown) => {
          log.warn(
            {
              requestId,
              datasourceId: id,
              err: closeErr instanceof Error ? closeErr : new Error(String(closeErr)),
            },
            "Failed to close profiling connection (best-effort)",
          );
        });
        closed = true;
        try {
          controller.close();
        } catch {
          // intentionally ignored: the stream may already be closed by an
          // aborted consumer; closing twice is a harmless no-op.
        }
      }
    },
  });

  // The NDJSON stream is a raw Response. OpenAPIHono's `.openapi()` handler
  // expects a typed `c.json()` return, so — mirroring the chat route — throw it
  // as an HTTPException(200) and let the router's `onError` return it unchanged
  // via `getResponse()`, bypassing the typed-return requirement.
  const streamResponse = new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
  throw new HTTPException(200, { res: streamResponse });
});
