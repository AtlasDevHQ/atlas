/**
 * OpenAPI Datasource primitive (v0.0.2 — REST Datasources).
 *
 * Two foundational deep modules, siblings to the SQL Datasource layer
 * (`lib/db/connection.ts`) — never folded into it (PRD #2868 "Option B").
 *
 *  - `openapi-spec` (`spec.ts`): `buildOperationGraph(doc)` — pure normalizer
 *    from an OpenAPI 3.x document to the {@link OperationGraph} (the shared
 *    shape every downstream consumer reads).
 *  - `openapi-client` (`client.ts`): `executeOperation(graph, id, params, auth)`
 *    — executes a single operation over HTTP. Transport primitive only.
 *
 * Deferred to later slices (clean extension points left in place): semantic-YAML
 * generation (1b), pagination (4), `validateRestOperation` (5), networkPolicy
 * threading (3), catalog/install surface (2).
 */
export { buildOperationGraph } from "./spec";
export { executeOperation, parseRetryAfterMs } from "./client";

// Slice-1 consumers (#2924) — the prompt-context representation (Path A) and the
// sandbox-Python client preamble. Pure functions over the slice-0 graph; the
// transitional env-driven `datasource.ts` resolver imports the logger and stays
// out of this barrel (slice 2's install registry replaces it).
export {
  buildAgentRepresentation,
  REPRESENTATION_MODES,
  RepresentationNotImplementedError,
} from "./representation";
export type {
  AgentRepresentation,
  BuildRepresentationOptions,
  RepresentationMode,
} from "./representation";
export { buildRestClientPreamble } from "./python-preamble";
export type { PreambleOptions } from "./python-preamble";

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HTTP_METHODS,
  OpenApiClientError,
  OpenApiSpecError,
} from "./types";

export type {
  ExecuteOptions,
  HttpMethod,
  OpenApiClientErrorReason,
  OpenApiSchema,
  OpenApiSpecErrorReason,
  Operation,
  OperationGraph,
  OperationParameter,
  OperationParams,
  OperationRequestBody,
  OperationResponse,
  OperationResult,
  ParameterLocation,
  ResolvedAuth,
  SecurityScheme,
  SecuritySchemeKind,
  ServerInfo,
  SpecInfo,
} from "./types";
