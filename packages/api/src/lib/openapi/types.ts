/**
 * Shared contract for the OpenAPI Datasource primitive (v0.0.2 milestone spine).
 *
 * This file defines the *one normalized shape* every downstream consumer of an
 * OpenAPI 3.x document reads — the semantic-YAML generator (slice 1b), the REST
 * validator (slice 5), the prompt-context builder, and the executing client
 * (`client.ts`) all consume {@link OperationGraph} rather than re-walking the
 * raw spec. There is exactly one parse boundary (`buildOperationGraph` in
 * `spec.ts`); past it, nobody touches a `$ref` string or a raw `paths.*` object.
 *
 * Design notes on the `$ref` model (load-bearing — see {@link OpenApiSchema.ref}):
 * named-component `$ref`s are resolved to a *pointer* (`{ ref: "Name" }`) rather
 * than inlined. This keeps the graph finite under circular relationships (e.g.
 * Twenty's Person ↔ NoteTarget cycle) while letting a consumer follow the join
 * with a single `graph.schemas.get(node.ref)` lookup. Inline (anonymous) schemas
 * are walked in full — they cannot be circular without a named `$ref`, so the
 * recursion always terminates.
 *
 * Sibling to the SQL Datasource layer (`lib/db/connection.ts`), never folded
 * into it — per PRD #2868 "Option B: parallel adapter, not subordinate".
 */
import { Data } from "effect";
import type { VendorQuirk } from "./vendor-quirk";

// ─────────────────────────────────────────────────────────────────────
//  Primitive enums
// ─────────────────────────────────────────────────────────────────────

/** HTTP methods OpenAPI 3.x permits on a Path Item, normalized to uppercase. */
export type HttpMethod =
  | "GET"
  | "PUT"
  | "POST"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "TRACE";

/** The eight Path Item method keys we walk, lowercase as they appear in the doc. */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

/** Where a parameter is carried in the request. */
export type ParameterLocation = "query" | "header" | "path" | "cookie";

/**
 * The kinds of security scheme this primitive understands. `oauth2` and
 * `openIdConnect` are *normalized* (so the graph is complete and the install
 * surface can display them) but their credential flows are deferred to slice 6;
 * the client (`client.ts`) only *applies* `bearer` / `basic` / `apiKey-*`.
 */
export type SecuritySchemeKind =
  | "bearer"
  | "basic"
  | "apiKey-header"
  | "apiKey-query"
  | "oauth2"
  | "openIdConnect";

// ─────────────────────────────────────────────────────────────────────
//  Normalized schema node
// ─────────────────────────────────────────────────────────────────────

/**
 * A normalized JSON-Schema node. We model only the fields downstream consumers
 * read; we deliberately do NOT mirror all of JSON Schema.
 *
 * It is a discriminated union on the presence of `ref`: a node is EITHER a
 * pointer to a named component ({@link OpenApiSchemaRef}) OR an inline schema
 * ({@link OpenApiSchemaInline}) — never both. Consumers narrow with
 * `if (node.ref !== undefined)`; the inline arm then exposes `type`,
 * `properties`, `items`, etc. with no need to re-check that `ref` is absent.
 */
export type OpenApiSchema = OpenApiSchemaRef | OpenApiSchemaInline;

/**
 * A reference to the named component schema `graph.schemas.get(ref)`. The
 * target is guaranteed to exist (parse fails loud otherwise). This is how
 * Person → NoteTarget joins are traversed without re-walking `$ref` strings,
 * and how cycles stay finite — a ref node carries no inline fields.
 */
export interface OpenApiSchemaRef {
  readonly ref: string;
  /** Set only when a top-level `components.schemas.*` entry IS itself a bare `$ref`. */
  readonly name?: string;
}

/** An inline (anonymous or named-but-non-`$ref`) schema, walked in full. */
export interface OpenApiSchemaInline {
  /** Discriminant: an inline node never carries a `ref`. */
  readonly ref?: undefined;
  /**
   * The component name when this node IS a `components.schemas.*` entry
   * (top-level registration). `undefined` for inline / anonymous schemas.
   */
  readonly name?: string;
  /** JSON Schema `type` (e.g. "object", "array", "string"). May be absent. */
  readonly type?: string;
  /** JSON Schema `format` hint (e.g. "uuid", "date-time", "int64"). */
  readonly format?: string;
  readonly description?: string;
  /** Allowed enumerated values, when the schema is an enum. */
  readonly enum?: ReadonlyArray<unknown>;
  /**
   * Nullability. Set from OpenAPI 3.0's `nullable: true`, or normalized from
   * OpenAPI 3.1's `type: [..., "null"]` array form (the "null" member is
   * stripped from `type` and surfaced here).
   */
  readonly nullable?: boolean;
  /** Required property names, for object schemas. */
  readonly required?: ReadonlyArray<string>;
  /** Object property name → normalized schema. */
  readonly properties?: ReadonlyMap<string, OpenApiSchema>;
  /** Element schema, for array schemas. */
  readonly items?: OpenApiSchema;
  /**
   * Composition keywords. Each branch is normalized recursively (resolved
   * `$ref`s become pointers), but the composition is NOT flattened/merged into
   * a single effective schema — consumers see the branches as authored.
   */
  readonly allOf?: ReadonlyArray<OpenApiSchema>;
  readonly oneOf?: ReadonlyArray<OpenApiSchema>;
  readonly anyOf?: ReadonlyArray<OpenApiSchema>;
}

// ─────────────────────────────────────────────────────────────────────
//  Security
// ─────────────────────────────────────────────────────────────────────

/**
 * A normalized `components.securitySchemes.*` entry. Discriminated on `kind`
 * so each scheme carries exactly the fields it needs — an `apiKey-*` scheme
 * always has a `parameterName` (the parse boundary guarantees it), and a
 * `bearer`/`basic` scheme never does. Consumers narrow on `kind` and access
 * `parameterName` without a runtime presence check.
 */
export type SecurityScheme =
  | { readonly kind: "bearer"; readonly name: string; readonly bearerFormat?: string; readonly description?: string }
  | { readonly kind: "basic"; readonly name: string; readonly description?: string }
  | {
      readonly kind: "apiKey-header" | "apiKey-query";
      readonly name: string;
      /** The header or query-parameter name carrying the key (e.g. "X-API-Key", "api_key"). */
      readonly parameterName: string;
      readonly description?: string;
    }
  | { readonly kind: "oauth2" | "openIdConnect"; readonly name: string; readonly description?: string };

// ─────────────────────────────────────────────────────────────────────
//  Operations
// ─────────────────────────────────────────────────────────────────────

/** A normalized operation parameter (`in: query | header | path | cookie`). */
export interface OperationParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  /** Always `true` for `in: path` per the OpenAPI spec. */
  readonly required: boolean;
  readonly description?: string;
  readonly schema?: OpenApiSchema;
}

/** A normalized request body. `content` is keyed by media type. */
export interface OperationRequestBody {
  readonly required: boolean;
  readonly description?: string;
  readonly content: ReadonlyMap<string, OpenApiSchema>;
}

/** A normalized response. `content` is keyed by media type. */
export interface OperationResponse {
  readonly description?: string;
  readonly content: ReadonlyMap<string, OpenApiSchema>;
}

/**
 * A single executable operation, keyed in the graph by `operationId`. This is
 * the unit the validator authorizes, the prompt-context builder describes, and
 * the client executes.
 */
export interface Operation {
  readonly operationId: string;
  readonly method: HttpMethod;
  /**
   * Operator-asserted override (#3008): `true` when the operation's spec carried
   * the `x-atlas-side-effecting: true` vendor extension. Such an operation MUTATES
   * state even if its {@link method} is a GET/HEAD (a mutating RPC-over-GET, e.g.
   * `GET /jobs/{id}/cancel`), so the validator forces it through the write
   * allowlist + confirm path. Absent → classify by method (the GET=read default).
   * Only `true` is ever set by the parser: an explicit `x-atlas-side-effecting:
   * false` is accepted but equivalent to absent (it leaves classification to the
   * method), so the two observable behaviors are "escalated" (`true`) vs "method-
   * default" (`false`/absent). A present-but-non-boolean value is rejected at parse
   * time — see {@link import("./spec").buildOperationGraph}.
   * De-escalation is impossible by design: a write method stays a write whatever
   * this flag says — see {@link import("./validate-rest-operation").isSideEffectingOperation}.
   */
  readonly sideEffecting?: boolean;
  /** The templated path, e.g. "/people/{id}". */
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: ReadonlyArray<string>;
  /** Path-level and operation-level parameters, merged and `$ref`-resolved. */
  readonly parameters: ReadonlyArray<OperationParameter>;
  readonly requestBody?: OperationRequestBody;
  /**
   * Security scheme names that satisfy this operation, OR-semantics (any one
   * suffices). Resolved from operation-level `security`, falling back to the
   * document-level default. An empty array means no auth is required (including
   * an explicit operation-level `security: []` override). Every name is
   * guaranteed present in `graph.security`.
   */
  readonly security: ReadonlyArray<string>;
  /** Responses keyed by status string ("200", "404", "default"). */
  readonly responses: ReadonlyMap<string, OperationResponse>;
}

// ─────────────────────────────────────────────────────────────────────
//  The graph (the spine)
// ─────────────────────────────────────────────────────────────────────

/** A server base URL from the document's `servers` array. */
export interface ServerInfo {
  readonly url: string;
  readonly description?: string;
}

/** Document identity, for diagnostics and the install surface. */
export interface SpecInfo {
  readonly title: string;
  readonly version: string;
  /** The raw `openapi` version string, e.g. "3.1.0". */
  readonly openapiVersion: string;
}

/**
 * The normalized operation graph — the single shape every downstream consumer
 * reads. Produced once by `buildOperationGraph`; never half-built (a parse
 * failure throws {@link OpenApiSpecError} rather than returning a partial graph).
 */
export interface OperationGraph {
  readonly operations: ReadonlyMap<string, Operation>;
  readonly schemas: ReadonlyMap<string, OpenApiSchema>;
  readonly security: ReadonlyMap<string, SecurityScheme>;
  readonly servers: ReadonlyArray<ServerInfo>;
  readonly info: SpecInfo;
}

// ─────────────────────────────────────────────────────────────────────
//  Execution contract (client.ts)
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolved credential material for a single execution. The caller (later: the
 * install layer reading encrypted config) resolves this; the client applies it.
 *
 * For `apiKey`, placement (header vs query, and the parameter name) is read from
 * the operation's apiKey security scheme by default. `placement` is an
 * all-or-nothing override for callers that store placement in config (slice 2's
 * form fields) rather than relying on the spec — supplying it as a single unit
 * makes a half-specified override (an `in` without a `name`) unrepresentable.
 */
export type ResolvedAuth =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | {
      readonly kind: "apiKey";
      readonly value: string;
      readonly placement?: { readonly in: "header" | "query"; readonly name: string };
    };

/**
 * Request inputs, bucketed by location so the client never has to guess where a
 * value belongs (directly satisfies "encode params per `in: query|header|path`").
 * `undefined` query values are dropped; array query values explode (repeat key).
 */
export interface OperationParams {
  readonly path?: Readonly<Record<string, string | number | boolean>>;
  readonly query?: Readonly<
    Record<string, string | number | boolean | ReadonlyArray<string | number | boolean> | undefined>
  >;
  readonly header?: Readonly<Record<string, string | number | boolean>>;
  /** JSON request body. Serialized with `JSON.stringify`; sets Content-Type. */
  readonly body?: unknown;
}

/** Per-execution options. */
export interface ExecuteOptions {
  /**
   * Base URL override. When omitted, the client uses `graph.servers[0].url`.
   * (Slice 2 threads `base_url_override` here.)
   */
  readonly baseUrl?: string;
  /** Per-request timeout in ms. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** `fetch` implementation override, for integration tests. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * A vendor's declarative deviations from plain REST (slice 6a, #3028): required
   * static headers + query param-shaping the client applies to THIS request
   * through its header / query seams. Data, not a code branch — a data candidate
   * (`data-candidates.ts`) supplies its {@link VendorQuirk} here via the resolved
   * {@link import("./datasource").RestDatasource}. Omit for a perfectly-generic API.
   */
  readonly quirk?: VendorQuirk;
}

/**
 * The result of a single execution. Returned for ANY HTTP response, including
 * 4xx/5xx — interpreting status is the caller's job (the validator / agent
 * decide what a 404 means), keeping this a transport primitive. Throws only for
 * client-side faults (unknown operation, missing path param, missing auth
 * placement) and transport faults (timeout, network). See {@link OpenApiClientError}.
 */
export interface OperationResult {
  readonly status: number;
  /** Response headers, lowercased keys. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON when the response is JSON; raw string otherwise; null if empty. */
  readonly body: unknown;
  /** True when `body` is a raw string because the response was not JSON. */
  readonly bodyIsRaw: boolean;
  /**
   * `Retry-After` parsed to milliseconds per RFC 9110, when the response
   * carried a parseable value (typically on 429 / 503). The client surfaces it;
   * it does NOT auto-retry (no agent logic in this layer).
   */
  readonly retryAfterMs?: number;
}

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Why a spec failed to parse. Machine-readable so consumers branch on it rather
 * than the message string. The graph is NEVER half-built — any of these throws.
 */
export type OpenApiSpecErrorReason =
  | "not-an-object"
  | "unsupported-version"
  | "missing-paths"
  | "missing-operation-id"
  | "duplicate-operation-id"
  | "unresolved-ref"
  | "unsupported-ref"
  | "invalid-security-scheme"
  | "unknown-security-requirement"
  | "invalid-parameter"
  | "invalid-structure";

/**
 * Thrown by `buildOperationGraph` at parse time. Fail-loud is the contract
 * (PRD risk R1): an unparseable spec must never half-build a graph that
 * surprises a later consumer. Carries what was wrong (`reason`, `message`) and
 * where (`location`, a JSON-pointer-ish path into the source document).
 */
export class OpenApiSpecError extends Data.TaggedError("OpenApiSpecError")<{
  readonly message: string;
  readonly reason: OpenApiSpecErrorReason;
  /** Source location, e.g. `paths./people.get` or `components.schemas.Person`. */
  readonly location?: string;
}> {}

/** Why an execution failed before or instead of producing an HTTP response. */
export type OpenApiClientErrorReason =
  | "unknown-operation"
  | "missing-base-url"
  | "missing-path-param"
  | "missing-auth-placement"
  | "blocked-egress" // target (or a redirect hop) resolves to a private/internal address — SSRF guard, #3006
  | "timeout"
  | "network"
  | "unparseable-response";

/**
 * Thrown by `executeOperation` for client-side and transport faults. A non-2xx
 * HTTP response is NOT an error here — it comes back as an {@link OperationResult}.
 */
export class OpenApiClientError extends Data.TaggedError("OpenApiClientError")<{
  readonly message: string;
  readonly reason: OpenApiClientErrorReason;
  readonly operationId: string;
  /** HTTP status; 0 for transport-level faults (timeout, network, abort). */
  readonly status: number;
  readonly retryAfterMs?: number;
}> {}

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Default per-request timeout (30s), matching the SQL Datasource statement
 * timeout default. Slice 2+ makes this configurable via `ATLAS_OPENAPI_TIMEOUT`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
