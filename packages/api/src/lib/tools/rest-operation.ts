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
  attemptDriftRecovery,
  type DriftRecoveryOutcome,
} from "@atlas/api/lib/openapi/drift-recovery";
import {
  buildRestWriteSummary,
  mintRestConfirmToken,
  type RestWriteConfirmRequest,
} from "@atlas/api/lib/openapi/rest-write-confirm";
import { auditRestOperation, deriveRestRowCount } from "@atlas/api/lib/openapi/rest-audit";
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
  /**
   * `specRefreshed` (#3315): present + `true` when the datasource's
   * `auto-refresh` drift mode just re-probed the upstream spec and the
   * operation is STILL not there — the agent should trust
   * `availableOperations` (now fresh) rather than retrying, and may tell the
   * user the API's spec may have changed.
   */
  | { status: "unknown_operation"; message: string; availableOperations: string[]; specRefreshed?: boolean }
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
  /**
   * Drift-recovery override (tests). Defaults to the real
   * {@link attemptDriftRecovery} — the debounced, egress-guarded re-probe the
   * `auto-refresh` drift mode runs on `unknown-operation` (#3315).
   */
  readonly driftRecovery?: typeof attemptDriftRecovery;
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

      // One validation + dispatch pass against a given datasource shape. Hoisted
      // into a closure so the #3315 drift-recovery path can retry EXACTLY once
      // with a freshly re-probed graph swapped in — no duplicated safety stack.
      const runOnce = async (ds: RestDatasource): Promise<ExecuteRestOperationResult> => {
        // Peek the method so we only debit the per-operation rate quota for calls
        // that actually hit the upstream (reads here; the confirmed write later).
        // Staging a write for confirmation must not burn quota. An unknown op falls
        // to `dispatch: true`, but layer 1 rejects it before the quota is touched.
        const peeked = ds.graph.operations.get(operationId);
        // Side-effecting (#3008) GET/HEADs count as writes here too, so they are
        // staged for confirmation (dispatch:false) rather than run immediately. A
        // candidate-declared read-safe POST (#3035) is demoted to a read by the same
        // predicate, so it dispatches immediately (debits the read quota) rather than
        // staging for a confirm that would be refused.
        const isWrite = peeked
          ? isSideEffectingOperation(
              peeked,
              ds.sideEffectingOperations,
              ds.readSafePostOperations,
            )
          : false;

        const policy: RestOperationPolicy = {
          // The rate-limit bucket is keyed (workspace, datasource, operation). In
          // the normal agent path an absent org short-circuits to `no_datasource`
          // before reaching here (datasources resolve from the org); the `"default"`
          // sentinel is only reachable via an injected resolver (tests), where the
          // `datasourceId` dimension still uniquely scopes the bucket.
          workspaceId: getRequestContext()?.user?.activeOrganizationId ?? "default",
          datasourceId: ds.id,
          writeAllowlist: ds.writeAllowlist,
          sideEffectingOperations: ds.sideEffectingOperations,
          ...(ds.readSafePostOperations !== undefined
            ? { readSafePostOperations: ds.readSafePostOperations }
            : {}),
          dispatch: !isWrite,
          ...(ds.rateLimitPerMinute !== undefined
            ? { rateLimitPerMinute: ds.rateLimitPerMinute }
            : {}),
          ...(ds.requestTimeoutMs !== undefined
            ? { requestedTimeoutMs: ds.requestTimeoutMs }
            : {}),
        };

        const verdict = validateRestOperation(ds.graph, operationId, params, policy);
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
              datasourceId: ds.id,
              operationId,
              params,
            });
          } catch (err) {
            const requestId = getRequestContext()?.requestId;
            const message = err instanceof Error ? err.message : String(err);
            log.error(
              { operationId, datasource: ds.id, requestId, err: message },
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
            datasourceId: ds.id,
            operationId,
            ...(pathParams ? { pathParams } : {}),
            ...(query ? { query } : {}),
            ...(header ? { header } : {}),
            ...(body !== undefined ? { body } : {}),
            token,
          };
          log.info(
            { operationId, method: verdict.operation.method, datasource: ds.id },
            "executeRestOperation staged a write for confirmation",
          );
          return {
            status: "needs_confirmation",
            method: verdict.operation.method,
            operationId,
            datasourceId: ds.id,
            datasourceName: ds.displayName,
            summary: buildRestWriteSummary(verdict.operation, ds.displayName),
            confirm,
          };
        }

        // The op is validated as existing + dispatchable, so `peeked` is defined;
        // the fallback is defensive only. Used for the audit descriptor's method.
        const dispatchMethod = peeked?.method ?? verdict.operation.method;
        // Only DISPATCHED outcomes below are audited — the pre-dispatch rejections
        // above never touched the datasource (they keep their `log.info` only).
        const dispatchStart = Date.now();
        try {
          const result = await executeOperation(ds.graph, operationId, params, ds.auth, {
            baseUrl: ds.baseUrl,
            timeoutMs: verdict.timeoutMs,
            // Slice 6a (#3028): a built-in data-candidate datasource (e.g. Stripe)
            // carries a declarative quirk — required headers / query param-shaping
            // (expand[]). The client applies it through its header/query seams.
            ...(ds.quirk ? { quirk: ds.quirk } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });

          if (result.status >= 200 && result.status < 300) {
            auditRestOperation({
              method: dispatchMethod,
              operationId,
              datasourceId: ds.id,
              baseUrl: ds.baseUrl,
              durationMs: Date.now() - dispatchStart,
              outcome: { success: true, rowCount: deriveRestRowCount(result.body) },
            });
            return { status: "ok", httpStatus: result.status, body: result.body };
          }
          // Non-2xx is not a transport error — surface it so the agent can adjust.
          const httpErrorMessage = `Upstream returned HTTP ${result.status} for "${operationId}".`;
          log.info(
            { operationId, httpStatus: result.status, datasource: ds.id },
            "executeRestOperation upstream non-2xx",
          );
          auditRestOperation({
            method: dispatchMethod,
            operationId,
            datasourceId: ds.id,
            baseUrl: ds.baseUrl,
            durationMs: Date.now() - dispatchStart,
            outcome: { success: false, error: httpErrorMessage },
          });
          return {
            status: "http_error",
            httpStatus: result.status,
            body: result.body,
            message: httpErrorMessage,
          };
        } catch (err) {
          const durationMs = Date.now() - dispatchStart;
          if (err instanceof OpenApiClientError) {
            log.warn(
              { operationId, reason: err.reason, datasource: ds.id },
              "executeRestOperation client fault",
            );
            // The dispatch began and then faulted (transport/parse) — audit it.
            auditRestOperation({
              method: dispatchMethod,
              operationId,
              datasourceId: ds.id,
              baseUrl: ds.baseUrl,
              durationMs,
              outcome: { success: false, error: err.message },
            });
            return {
              status: "client_error",
              reason: err.reason,
              message: err.message,
            };
          }
          const requestId = getRequestContext()?.requestId;
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            { operationId, requestId, err: message, datasource: ds.id },
            "executeRestOperation unexpected failure",
          );
          // A post-dispatch fault too (executeOperation threw after we entered the
          // dispatch) — audit it as a failed execution.
          auditRestOperation({
            method: dispatchMethod,
            operationId,
            datasourceId: ds.id,
            baseUrl: ds.baseUrl,
            durationMs,
            outcome: { success: false, error: message },
          });
          // Not an OpenApiClientError — a code bug / OOM / etc. Classify it as
          // `unexpected`, never `network`: a deterministic internal failure must
          // not read to the agent as a transient transport fault worth retrying.
          return {
            status: "client_error",
            reason: "unexpected",
            message: `Unexpected internal error executing "${operationId}": ${message}`,
          };
        }
      };

      const first = await runOnce(datasource);
      if (first.status !== "unknown_operation") return first;

      // ── #3315 — query-time spec-drift recovery. The operation isn't in the
      // CACHED graph; in `auto-refresh` mode the upstream spec may have
      // legitimately changed, so attempt ONE debounced, egress-guarded re-probe
      // and retry iff the fresh graph contains the operation. `strict` (the
      // default, including an absent field) preserves the hard reject exactly.
      if (datasource.specDriftMode !== "auto-refresh") return first;
      const recover = deps.driftRecovery ?? attemptDriftRecovery;
      const workspaceId = getRequestContext()?.user?.activeOrganizationId ?? "default";
      let recovery: DriftRecoveryOutcome;
      try {
        recovery = await recover(workspaceId, datasource.id, operationId);
      } catch (err) {
        // attemptDriftRecovery's contract is never-throws; this guards an
        // injected seam. Fail closed — the original rejection stands.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { operationId, datasource: datasource.id, err: message },
          "executeRestOperation drift-recovery attempt threw — returning the original rejection",
        );
        return first;
      }
      // Cooldown / row gone / probe failure: the old snapshot is untouched and
      // the original rejection (with its availableOperations hint) stands.
      if (recovery.kind !== "refreshed") return first;
      if (!recovery.operationFound) {
        // The spec WAS just re-checked and the operation still isn't there —
        // tell the agent the list is fresh so it stops retrying, and that the
        // upstream contract may have changed (it may relay that to the user).
        return {
          status: "unknown_operation",
          specRefreshed: true,
          message:
            `Unknown operationId "${operationId}". The upstream spec was just re-checked (it may have ` +
            `changed) and this operation is still not present — pick from availableOperations (now fresh); ` +
            `do not retry "${operationId}".`,
          availableOperations: [...recovery.graph.operations.keys()].toSorted(),
        };
      }
      log.info(
        { operationId, datasource: datasource.id },
        "executeRestOperation drift recovery found the operation in the refreshed spec — retrying once",
      );
      // Retry with the fresh graph, and the fresh base URL ONLY when recovery
      // re-derived one that re-passed the egress guard (a legitimately moved
      // servers[0].url is followed; a hostile/blocked one is dropped and the
      // already-validated old base stays). Auth/allowlists stay from the
      // current resolve; guardedFetch remains the execution-time backstop.
      return runOnce({
        ...datasource,
        graph: recovery.graph,
        ...(recovery.baseUrl !== undefined ? { baseUrl: recovery.baseUrl } : {}),
      });
    },
  });
}
