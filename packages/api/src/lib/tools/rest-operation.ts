/**
 * `executeRestOperation` — the single-operation agent tool for REST datasources
 * (PRD #2868 slice 1 #2924; workspace-scoped + multi-datasource in slice 2 #2926;
 * write-side opt-in in slice 5 #2929).
 *
 * The convenience shortcut for trivially simple REST lookups: the agent passes
 * an `operationId` (from the representation in its system prompt) plus the
 * params, and this tool dispatches through the slice-0 {@link executeOperation}
 * client. Multi-step composition ("fetch each person's notes") is expressed as
 * a sequence of these calls across agent steps. Slice 3 (#2927) landed the
 * sandbox network boundary the in-sandbox composition path depends on; the
 * in-sandbox `AtlasRestClient` composition path itself stays deferred (it can't
 * authenticate read-only), so the authenticated read path remains this
 * host-side tool.
 *
 * **Workspace-scoped (slice 2).** Datasources are resolved per-request from the
 * workspace's `openapi-generic` installs (via the ambient request context's
 * org id) — the slice-1 `ATLAS_OPENAPI_TWENTY*` env path is retired. A workspace
 * can have several (Twenty + Stripe + …); the agent disambiguates with an
 * optional `datasourceId` (required only when more than one is installed). The
 * representation in the prompt labels each datasource's id.
 *
 * **The safety boundary (slice 5).** Every call is authorized by
 * {@link validateRestOperation} — the REST sibling to `validateSQL`:
 *   - GET / HEAD execute (rate-limited, then dispatched to the upstream).
 *   - A non-GET (write) executes ONLY if its `operationId` is in the datasource's
 *     `write_allowlist`; otherwise → `writes_disabled` (default-deny), and the
 *     request never fires.
 *   - An allowlisted write is NOT dispatched here — it returns `needs_confirmation`,
 *     and the chat surface shows a confirm-before-write banner. The write fires
 *     only after the user confirms (via the confirm endpoint), never silently.
 * Writes are never written to any cache (this tool calls the un-cached
 * {@link executeOperation} primitive directly).
 *
 * Structured results mirror `sendEmail`'s discriminated-union convention: every
 * branch the agent must distinguish is its own `status` so the model can
 * self-correct or stop looping instead of guessing from a free-text error.
 */
import { tool } from "ai";
import { z } from "zod";

import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { executeOperation } from "@atlas/api/lib/openapi/client";
import { OpenApiClientError, type OpenApiClientErrorReason } from "@atlas/api/lib/openapi/types";
import { type RestDatasource } from "@atlas/api/lib/openapi/datasource";
import {
  resolveWorkspaceRestDatasourcesOrThrow,
  RestDatasourceReconnectError,
} from "@atlas/api/lib/openapi/workspace-datasource";
import {
  validateRestOperation,
  isSideEffectingOperation,
  type RestOperationPolicy,
} from "@atlas/api/lib/openapi/validate-rest-operation";
import {
  buildRestWriteSummary,
  mintRestConfirmToken,
  type RestWriteConfirmRequest,
} from "@atlas/api/lib/openapi/rest-write-confirm";
import type { OperationParams } from "@atlas/api/lib/openapi/types";

const log = createLogger("tools.rest-operation");

export const REST_OPERATION_DESCRIPTION = `### Read & write a REST Datasource
Use executeRestOperation to call a single operation on a connected REST API (described under "REST Datasource" in this prompt):
- Pass the \`operationId\` exactly as listed, plus \`pathParams\` (for {id}-style path tokens), \`query\` (filters, limits, cursors), and \`body\` where the operation defines one
- When more than one REST datasource is connected, pass \`datasourceId\` (shown in each datasource's header) to pick which one
- Compose the filter \`query\` value yourself in the documented \`field[op]:value\` syntax — do NOT invent a bracketed form
- For multi-step questions, call this tool once per step and feed each result into the next (e.g. find a person, then list their note targets, then fetch each note)
- GET operations execute and return data immediately — UNLESS that GET is flagged side-effecting (by the datasource's spec or its admin config). Some legacy/internal APIs mutate via GET (e.g. \`GET /jobs/{id}/cancel\`); a flagged GET is treated exactly like a write — it needs allowlisting and is staged for confirmation, never run silently.
- Write operations (POST/PATCH/PUT/DELETE) only run if the datasource's admin has allowlisted them. A non-allowlisted write returns \`writes_disabled\` — tell the user writes are off for that datasource; never claim it happened.
- EXCEPTION: a few operations use POST for a READ (e.g. a search endpoint like Notion's \`post-search\`). When the datasource marks such a POST read-safe it executes and returns data immediately, exactly like a GET — so if the operation that answers a read question is a POST, call it. (A genuine write still comes back as \`needs_confirmation\`, never silently.)
- An allowlisted write does NOT run immediately: it returns \`needs_confirmation\`. Tell the user plainly what the write will do (e.g. "This will permanently delete 3 people in Twenty — confirm?") and STOP. The user confirms via the banner; do not retry, and never claim the write succeeded until you see a confirmed result.`;

/**
 * The tool's `client_error` reason: the slice-0 client's transport/parse reasons,
 * plus a `unexpected` catch-all for a non-{@link OpenApiClientError} fault (a code
 * bug, OOM, etc.). Keeping `unexpected` distinct from `network` stops the agent
 * reading a deterministic internal failure as a transient transport blip worth
 * retrying.
 */
export type RestToolClientErrorReason = OpenApiClientErrorReason | "unexpected";

/** The discriminated result the agent reads. */
export type ExecuteRestOperationResult =
  | { status: "ok"; httpStatus: number; body: unknown }
  | { status: "http_error"; httpStatus: number; body: unknown; message: string }
  | { status: "no_datasource"; message: string }
  /**
   * The workspace's REST datasource exists but couldn't be made usable right now —
   * either the registry couldn't be loaded (a transient config-store failure) or a
   * connected datasource's credential is unresolvable and needs reconnecting (e.g.
   * a github-data install whose GitHub App access was revoked, #3030). Distinct
   * from `no_datasource` (the workspace genuinely has none): the agent must NOT
   * tell the user no datasource is connected — the `message` says whether to retry
   * shortly or to reconnect. See #2929 review.
   */
  | { status: "datasource_unavailable"; message: string }
  | { status: "datasource_not_found"; message: string; availableDatasources: string[] }
  | { status: "unknown_operation"; message: string; availableOperations: string[] }
  | { status: "writes_disabled"; message: string; method: string }
  | { status: "invalid_params"; message: string; missingParams?: string[]; unexpectedParams?: string[] }
  | { status: "rate_limited"; message: string; retryAfterMs?: number }
  /**
   * An allowlisted write, staged for human confirmation (slice 5). The request
   * has NOT fired. `confirm` is the exact replay payload the confirm-before-write
   * banner POSTs to `/api/v1/rest-operations/confirm`; `summary` is the
   * human-facing description the banner renders.
   */
  | {
      status: "needs_confirmation";
      method: string;
      operationId: string;
      datasourceId: string;
      datasourceName: string;
      summary: string;
      confirm: RestWriteConfirmRequest;
    }
  | { status: "client_error"; reason: RestToolClientErrorReason; message: string };

const queryScalar = z.union([z.string(), z.number(), z.boolean()]);

const ExecuteRestOperationInput = z.object({
  operationId: z
    .string()
    .min(1)
    .describe("The operationId to call, exactly as listed in the REST Datasource section."),
  datasourceId: z
    .string()
    .optional()
    .describe(
      "Which REST datasource to call, when more than one is connected. Use the id shown in the datasource's prompt header. Optional when only one is connected.",
    ),
  pathParams: z
    .record(z.string(), queryScalar)
    .optional()
    .describe("Values for {token} path parameters, e.g. { id: \"...\" }."),
  query: z
    .record(z.string(), z.union([queryScalar, z.array(queryScalar)]))
    .optional()
    .describe(
      "Query parameters, e.g. { filter: \"emails.primaryEmail[eq]:a@b.com\", limit: 10 }.",
    ),
  header: z
    .record(z.string(), queryScalar)
    .optional()
    .describe("Values for any `in: header` parameters the operation declares."),
  body: z
    .unknown()
    .optional()
    .describe(
      "JSON request body. For a write (POST/PATCH/PUT/DELETE) it must be allowlisted and is staged for the user to confirm (it does not fire immediately); a non-allowlisted write is rejected. A read-safe POST (e.g. a search endpoint) takes its body too and runs immediately, like a read.",
    ),
});

/**
 * Test seams. `resolveDatasources` is the slice-2 multi-datasource resolver;
 * `resolveDatasource` is the slice-1 single-datasource seam, wrapped into a
 * one-element array for back-compat (existing tests inject it). When neither is
 * given, datasources resolve from the ambient request context's workspace.
 */
export interface ExecuteRestOperationDeps {
  readonly resolveDatasources?: () => Promise<ReadonlyArray<RestDatasource>>;
  readonly resolveDatasource?: () => Promise<RestDatasource | null>;
  /** `fetch` override threaded into the slice-0 client (tests). */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Resolve the workspace's datasources from the ambient request context. Uses the
 * strict resolver so a registry load failure (DB outage) propagates and surfaces
 * as `datasource_unavailable` — distinct from an empty workspace (#2929 review).
 */
function resolveFromContext(): Promise<ReadonlyArray<RestDatasource>> {
  const orgId = getRequestContext()?.user?.activeOrganizationId;
  if (!orgId) return Promise.resolve([]);
  return resolveWorkspaceRestDatasourcesOrThrow(orgId);
}

export function createExecuteRestOperationTool(deps: ExecuteRestOperationDeps = {}) {
  const resolveDatasources: () => Promise<ReadonlyArray<RestDatasource>> =
    deps.resolveDatasources ??
    (deps.resolveDatasource
      ? async () => {
          const single = await deps.resolveDatasource!();
          return single ? [single] : [];
        }
      : resolveFromContext);

  return tool({
    description:
      "Call a single operation on a connected REST datasource by operationId. GET operations " +
      "execute and return data immediately, UNLESS a GET is flagged side-effecting — by the " +
      "datasource's spec or its admin config (some legacy APIs mutate via GET). Those, like write " +
      "operations (POST/PATCH/PUT/DELETE), run only if allowlisted, and an allowlisted write / " +
      "side-effecting GET is staged for the user to confirm before it fires (never claim a write " +
      "happened until confirmed). A few operations use POST for a READ (e.g. a search endpoint); a " +
      "datasource-configured read-safe POST runs immediately and returns data like a GET.",
    inputSchema: ExecuteRestOperationInput,
    execute: async ({ operationId, datasourceId, pathParams, query, header, body }): Promise<ExecuteRestOperationResult> => {
      let datasources: ReadonlyArray<RestDatasource>;
      try {
        datasources = await resolveDatasources();
      } catch (err) {
        const requestId = getRequestContext()?.requestId;
        // A connected datasource exists but its credential couldn't be resolved
        // (e.g. a github-data install whose GitHub App access was revoked) — this
        // is NOT "no datasource connected", it's "reconnect needed". Surface that
        // distinctly so the agent points the user at a reconnect, not a dead end.
        if (err instanceof RestDatasourceReconnectError) {
          log.warn(
            { requestId, reconnectableCount: err.reconnectableCount },
            "executeRestOperation: workspace's REST datasource(s) need reconnecting — credential unresolvable",
          );
          return {
            status: "datasource_unavailable",
            message:
              "This workspace's REST datasource is connected but Atlas couldn't authenticate to it right now — " +
              "its credential needs to be refreshed (the connection may have been revoked or expired). Tell the " +
              "user to reconnect it from Admin → Connections; do NOT claim no datasource is connected.",
          };
        }
        // The registry load failed (DB outage) — surface it as temporarily
        // unavailable, NOT as "no datasource connected". A false "none is
        // connected" claim would hide the outage from the user.
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { requestId, err: message },
          "executeRestOperation could not load the workspace's REST datasources",
        );
        return {
          status: "datasource_unavailable",
          message:
            "Couldn't load this workspace's REST datasources right now — a temporary error reaching Atlas's " +
            "configuration store. This does NOT mean none is connected: tell the user the REST datasource is " +
            "temporarily unavailable and to retry shortly; do not claim it isn't configured.",
        };
      }
      if (datasources.length === 0) {
        return {
          status: "no_datasource",
          message:
            "No REST datasource is configured for this workspace. Answer from another source or tell the user no REST datasource is connected.",
        };
      }

      // Pick the datasource: by explicit id, or the sole one when unambiguous.
      let datasource: RestDatasource | undefined;
      if (datasourceId !== undefined) {
        datasource = datasources.find((d) => d.id === datasourceId);
        if (!datasource) {
          return {
            status: "datasource_not_found",
            message: `No connected REST datasource has id "${datasourceId}". Pick one from availableDatasources.`,
            availableDatasources: datasources.map((d) => d.id),
          };
        }
      } else if (datasources.length === 1) {
        datasource = datasources[0];
      } else {
        return {
          status: "datasource_not_found",
          message:
            "More than one REST datasource is connected — pass datasourceId to choose which one to call.",
          availableDatasources: datasources.map((d) => d.id),
        };
      }

      const params: OperationParams = {
        ...(pathParams ? { path: pathParams } : {}),
        ...(query ? { query } : {}),
        ...(header ? { header } : {}),
        ...(body !== undefined ? { body } : {}),
      };

      // Peek the method so we only debit the per-operation rate quota for calls
      // that actually hit the upstream (reads here; the confirmed write later).
      // Staging a write for confirmation must not burn quota. An unknown op falls
      // to `dispatch: true`, but layer 1 rejects it before the quota is touched.
      const peeked = datasource.graph.operations.get(operationId);
      // Side-effecting (#3008) GET/HEADs count as writes here too, so they are
      // staged for confirmation (dispatch:false) rather than run immediately. A
      // candidate-declared read-safe POST (#3035) is demoted to a read by the same
      // predicate, so it dispatches immediately (debits the read quota) rather than
      // staging for a confirm that would be refused.
      const isWrite = peeked
        ? isSideEffectingOperation(
            peeked,
            datasource.sideEffectingOperations,
            datasource.readSafePostOperations,
          )
        : false;

      const policy: RestOperationPolicy = {
        // The rate-limit bucket is keyed (workspace, datasource, operation). In
        // the normal agent path an absent org short-circuits to `no_datasource`
        // before reaching here (datasources resolve from the org); the `"default"`
        // sentinel is only reachable via an injected resolver (tests), where the
        // `datasourceId` dimension still uniquely scopes the bucket.
        workspaceId: getRequestContext()?.user?.activeOrganizationId ?? "default",
        datasourceId: datasource.id,
        writeAllowlist: datasource.writeAllowlist,
        sideEffectingOperations: datasource.sideEffectingOperations,
        ...(datasource.readSafePostOperations !== undefined
          ? { readSafePostOperations: datasource.readSafePostOperations }
          : {}),
        dispatch: !isWrite,
        ...(datasource.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: datasource.rateLimitPerMinute }
          : {}),
        ...(datasource.requestTimeoutMs !== undefined
          ? { requestedTimeoutMs: datasource.requestTimeoutMs }
          : {}),
      };

      const verdict = validateRestOperation(datasource.graph, operationId, params, policy);
      if (!verdict.allowed) {
        const { error } = verdict;
        switch (error.reason) {
          case "unknown-operation":
            return {
              status: "unknown_operation",
              message: error.message,
              availableOperations: [...(error.availableOperations ?? [])],
            };
          case "writes-disabled":
            return {
              status: "writes_disabled",
              method: peeked?.method ?? "WRITE",
              message: error.message,
            };
          case "invalid-params":
            return {
              status: "invalid_params",
              message: error.message,
              ...(error.missingParams ? { missingParams: [...error.missingParams] } : {}),
              ...(error.unexpectedParams ? { unexpectedParams: [...error.unexpectedParams] } : {}),
            };
          case "rate-limit-exceeded":
            return {
              status: "rate_limited",
              message: error.message,
              ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
            };
          case "timeout-exceeded":
            // A misconfigured per-install timeout is an operator concern, not an
            // agent one — surface it as a client_error so the model stops.
            return { status: "client_error", reason: "timeout", message: error.message };
          default: {
            // Fail closed: a future RestValidationReason that isn't handled must NOT
            // fall through to dispatch — surface it as a client_error so the agent stops.
            const _exhaustive: never = error.reason;
            return {
              status: "client_error",
              reason: "unexpected",
              message: `Operation "${operationId}" was rejected by an unhandled validation rule (${String(_exhaustive)}).`,
            };
          }
        }
      }

      // Allowlisted write — stage for confirm-before-write; never dispatch here.
      if (verdict.requiresConfirmation) {
        // #3007: mint the single-use confirm token binding this exact staged write.
        // If no signing key is configured the gate can't be enforced, so we refuse
        // to stage rather than offer an unverifiable confirm (the oauth-state-token
        // fail-loud stance) — surfaced as a client_error so the agent stops cleanly.
        let token: string;
        try {
          token = mintRestConfirmToken({
            workspaceId: getRequestContext()?.user?.activeOrganizationId ?? "default",
            datasourceId: datasource.id,
            operationId,
            params,
          });
        } catch (err) {
          const requestId = getRequestContext()?.requestId;
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { operationId, datasource: datasource.id, requestId, err: message },
            "executeRestOperation could not mint a confirm token",
          );
          return {
            status: "client_error",
            reason: "unexpected",
            message:
              "Could not stage this write for confirmation — the server is missing a signing key for confirm tokens. " +
              "Tell the user the write can't be confirmed right now; do not claim it ran.",
          };
        }
        const confirm: RestWriteConfirmRequest = {
          datasourceId: datasource.id,
          operationId,
          ...(pathParams ? { pathParams } : {}),
          ...(query ? { query } : {}),
          ...(header ? { header } : {}),
          ...(body !== undefined ? { body } : {}),
          token,
        };
        log.info(
          { operationId, method: verdict.operation.method, datasource: datasource.id },
          "executeRestOperation staged a write for confirmation",
        );
        return {
          status: "needs_confirmation",
          method: verdict.operation.method,
          operationId,
          datasourceId: datasource.id,
          datasourceName: datasource.displayName,
          summary: buildRestWriteSummary(verdict.operation, datasource.displayName),
          confirm,
        };
      }

      try {
        const result = await executeOperation(datasource.graph, operationId, params, datasource.auth, {
          baseUrl: datasource.baseUrl,
          timeoutMs: verdict.timeoutMs,
          // Slice 6a (#3028): a built-in data-candidate datasource (e.g. Stripe)
          // carries a declarative quirk — required headers / query param-shaping
          // (expand[]). The client applies it through its header/query seams.
          ...(datasource.quirk ? { quirk: datasource.quirk } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });

        if (result.status >= 200 && result.status < 300) {
          return { status: "ok", httpStatus: result.status, body: result.body };
        }
        // Non-2xx is not a transport error — surface it so the agent can adjust.
        log.info(
          { operationId, httpStatus: result.status, datasource: datasource.id },
          "executeRestOperation upstream non-2xx",
        );
        return {
          status: "http_error",
          httpStatus: result.status,
          body: result.body,
          message: `Upstream returned HTTP ${result.status} for "${operationId}".`,
        };
      } catch (err) {
        if (err instanceof OpenApiClientError) {
          log.warn(
            { operationId, reason: err.reason, datasource: datasource.id },
            "executeRestOperation client fault",
          );
          return {
            status: "client_error",
            reason: err.reason,
            message: err.message,
          };
        }
        const requestId = getRequestContext()?.requestId;
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { operationId, requestId, err: message, datasource: datasource.id },
          "executeRestOperation unexpected failure",
        );
        // Not an OpenApiClientError — a code bug / OOM / etc. Classify it as
        // `unexpected`, never `network`: a deterministic internal failure must
        // not read to the agent as a transient transport fault worth retrying.
        return {
          status: "client_error",
          reason: "unexpected",
          message: `Unexpected internal error executing "${operationId}": ${message}`,
        };
      }
    },
  });
}
