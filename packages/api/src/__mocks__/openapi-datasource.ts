/**
 * Shared mock factory for REST datasources — the `createConnectionMock()`
 * analogue for OpenAPI datasources (PRD #2868 slice 2, AC6 / #2926). Builds a
 * {@link RestDatasource} from a small self-contained OpenAPI 3.1 doc (no file
 * I/O, no DB) so tests across the agent loop, the `executeRestOperation` tool,
 * and the registry get a real normalized {@link OperationGraph} without
 * hand-rolling fixtures or reaching for `mock.module()`.
 *
 * Pair with `createOpenApiDatasourceTestLayer()` (registry.ts) when an
 * Effect consumer needs the datasource injected via `Layer.provide`.
 *
 * Importable as `@atlas/api/testing/openapi-datasource` (the `testing` alias →
 * `src/__mocks__`), mirroring `@atlas/api/testing/connection`.
 */

import { buildOperationGraph } from "@atlas/api/lib/openapi/spec";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import type { ResolvedAuth } from "@atlas/api/lib/openapi/types";
import type { RepresentationMode } from "@atlas/api/lib/openapi/representation";

/**
 * A minimal but realistic OpenAPI 3.1 doc: one list + one get-by-id operation
 * over a `Widget` resource, with a `filter` query param and a `$ref` record
 * schema — enough surface to exercise representation rendering and single-
 * operation execution. Deliberately tiny so the graph builds fast.
 */
export const MOCK_OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: { title: "Mock Widget API", version: "1.0.0" },
  servers: [{ url: "https://widgets.example.com/api" }],
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        parameters: [
          {
            name: "filter",
            in: "query",
            required: false,
            description: "Filter in field[op]:value syntax, e.g. name[eq]:foo",
            schema: { type: "string" },
          },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Widget" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        summary: "Get a widget by id",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Widget" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Widget: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
} as const;

export interface OpenApiDatasourceMockOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly auth?: ResolvedAuth;
  readonly representationMode?: RepresentationMode;
  /** Override the spec doc the graph is built from (e.g. to load Twenty's). */
  readonly doc?: unknown;
  /**
   * operationIds permitted to write (slice 5, #2929). Defaults to **empty
   * (read-only / default-deny)** — pass e.g. `["createWidget"]` to opt a write in.
   */
  readonly writeAllowlist?: Iterable<string>;
  /**
   * operationIds whose GET/HEAD mutates state (#3008) — forced through the write
   * allowlist + confirm path. Defaults to **empty** (classification is method-only).
   */
  readonly sideEffectingOperations?: Iterable<string>;
  /** Per-install rate-limit override (calls/min); default 60 in the validator. */
  readonly rateLimitPerMinute?: number;
}

/**
 * Build a {@link RestDatasource} fixture. Defaults to the {@link
 * MOCK_OPENAPI_SPEC} Widget API with bearer auth, the bake-off-default
 * `operation-graph` representation mode, and an **empty write allowlist
 * (read-only)**; override any field.
 */
export function createOpenApiDatasourceMock(
  options: OpenApiDatasourceMockOptions = {},
): RestDatasource {
  const graph = buildOperationGraph(options.doc ?? MOCK_OPENAPI_SPEC);
  return {
    id: options.id ?? "mock-rest",
    displayName: options.displayName ?? graph.info.title,
    graph,
    baseUrl: options.baseUrl ?? graph.servers[0]?.url ?? "https://widgets.example.com/api",
    auth: options.auth ?? { kind: "bearer", token: "test-token" },
    representationMode: options.representationMode ?? "operation-graph",
    writeAllowlist: new Set(options.writeAllowlist ?? []),
    sideEffectingOperations: new Set(options.sideEffectingOperations ?? []),
    ...(options.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: options.rateLimitPerMinute } : {}),
  };
}
