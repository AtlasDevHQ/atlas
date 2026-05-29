/**
 * `executeRestOperation` — the single-operation agent tool for REST datasources
 * (PRD #2868 slice 1 #2924; workspace-scoped + multi-datasource in slice 2 #2926).
 *
 * The convenience shortcut for trivially simple REST lookups: the agent passes
 * an `operationId` (from the representation in its system prompt) plus the
 * params, and this tool dispatches through the slice-0 {@link executeOperation}
 * client. Multi-step composition ("fetch each person's notes") is expressed as
 * a sequence of these calls across agent steps. Slice 3 (#2927) landed the
 * sandbox network boundary the in-sandbox composition path depends on; the
 * in-sandbox `AtlasRestClient` composition path itself stays deferred (it can't
 * authenticate read-only), so the authenticated read path remains this
 * host-side tool until read-only is mediated host-side (pairs with slice-5).
 *
 * **Workspace-scoped (slice 2).** Datasources are resolved per-request from the
 * workspace's `openapi-generic` installs (via the ambient request context's
 * org id) — the slice-1 `ATLAS_OPENAPI_TWENTY*` env path is retired. A workspace
 * can have several (Twenty + Stripe + …); the agent disambiguates with an
 * optional `datasourceId` (required only when more than one is installed). The
 * representation in the prompt labels each datasource's id.
 *
 * Read-only in this release. Only GET / HEAD operations execute; any
 * POST/PATCH/PUT/DELETE returns a `writes_disabled` status. Write support is
 * gated behind slice 5's per-endpoint `write_allowlist` (#2929).
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
import { resolveWorkspaceRestDatasources } from "@atlas/api/lib/openapi/workspace-datasource";
import type { OperationParams } from "@atlas/api/lib/openapi/types";

const log = createLogger("tools.rest-operation");

export const REST_OPERATION_DESCRIPTION = `### Read a REST Datasource
Use executeRestOperation to call a single operation on a connected REST API (described under "REST Datasource" in this prompt):
- Pass the \`operationId\` exactly as listed, plus \`pathParams\` (for {id}-style path tokens), \`query\` (filters, limits, cursors), and \`body\` where the operation defines one
- When more than one REST datasource is connected, pass \`datasourceId\` (shown in each datasource's header) to pick which one
- Compose the filter \`query\` value yourself in the documented \`field[op]:value\` syntax — do NOT invent a bracketed form
- For multi-step questions, call this tool once per step and feed each result into the next (e.g. find a person, then list their note targets, then fetch each note)
- Read-only: only GET operations execute. Write operations are described but rejected; never claim a write happened`;

/** The discriminated result the agent reads. */
export type ExecuteRestOperationResult =
  | { status: "ok"; httpStatus: number; body: unknown }
  | { status: "http_error"; httpStatus: number; body: unknown; message: string }
  | { status: "no_datasource"; message: string }
  | { status: "datasource_not_found"; message: string; availableDatasources: string[] }
  | { status: "unknown_operation"; message: string; availableOperations: string[] }
  | { status: "writes_disabled"; message: string; method: string }
  | { status: "client_error"; reason: OpenApiClientErrorReason; message: string };

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
    .describe("JSON request body for write operations (rejected while read-only)."),
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

/** Resolve the workspace's datasources from the ambient request context. */
function resolveFromContext(): Promise<ReadonlyArray<RestDatasource>> {
  const orgId = getRequestContext()?.user?.activeOrganizationId;
  if (!orgId) return Promise.resolve([]);
  return resolveWorkspaceRestDatasources(orgId);
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
      "Call a single operation on a connected REST datasource by operationId. Read-only.",
    inputSchema: ExecuteRestOperationInput,
    execute: async ({ operationId, datasourceId, pathParams, query, header, body }): Promise<ExecuteRestOperationResult> => {
      const datasources = await resolveDatasources();
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

      const operation = datasource.graph.operations.get(operationId);
      if (!operation) {
        const availableOperations = [...datasource.graph.operations.keys()].toSorted();
        return {
          status: "unknown_operation",
          message: `Unknown operationId "${operationId}" on datasource "${datasource.id}". Pick one from availableOperations.`,
          availableOperations,
        };
      }

      // Read-only guard — writes are slice 5 (#2929). Never dispatch a mutation.
      if (operation.method !== "GET" && operation.method !== "HEAD") {
        return {
          status: "writes_disabled",
          method: operation.method,
          message:
            `Operation "${operationId}" is a ${operation.method} (write). Write operations are not yet ` +
            `enabled — they require a per-endpoint allowlist that ships in a later release. Do not claim it succeeded.`,
        };
      }

      const params: OperationParams = {
        ...(pathParams ? { path: pathParams } : {}),
        ...(query ? { query } : {}),
        ...(header ? { header } : {}),
        ...(body !== undefined ? { body } : {}),
      };

      try {
        const result = await executeOperation(datasource.graph, operationId, params, datasource.auth, {
          baseUrl: datasource.baseUrl,
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
        return {
          status: "client_error",
          reason: "network",
          message: `Failed to execute "${operationId}": ${message}`,
        };
      }
    },
  });
}
