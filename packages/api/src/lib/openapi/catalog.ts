/**
 * `openapi-generic` catalog row — the single source of truth for the built-in
 * generic OpenAPI Datasource (PRD #2868 slice 2, #2926).
 *
 * Per ADR-0007, built-in Datasource catalog rows are **code-seeded at boot**
 * (not declared in `atlas.config.ts`), so every Atlas deployment ships the
 * `openapi-generic` row available with no operator config edit. This module is
 * the one place its `slug` / `name` / `config_schema` live; the boot seed
 * (`catalog-seed.ts`), migration 0108, the form install
 * handler, and the workspace resolver all import from here so a field change
 * propagates to every surface at compile time instead of drifting.
 *
 * **Why not in `seed-builtin-datasource-catalog.ts`?** That module + its
 * `BUILTIN_DATASOURCE_CATALOG_SLUGS` allowlist describe the eight *SQL* pool
 * datasources — the boot loader (`db/internal.ts::loadSavedConnections`) and
 * the registry bridge translate each into a `ConnectionRegistry` pool via
 * `catalogSlugToDbType`. A REST datasource has no SQL pool; it resolves through
 * a parallel registry (PRD §"Option B — parallel adapter, not subordinate").
 * Keeping `openapi-generic` OUT of that slug list is what makes the SQL boot
 * loader skip it for free (`pc.slug = ANY(BUILTIN_DATASOURCE_CATALOG_SLUGS)`),
 * so the fork stays clean.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { CatalogId } from "@atlas/api/lib/integrations/install/types";
import { REPRESENTATION_MODES, type RepresentationMode } from "./representation";

const log = createLogger("openapi.catalog");

/** Catalog slug — the dispatch key in `registerFormHandler`. */
export const OPENAPI_GENERIC_SLUG: CatalogId = "openapi-generic";

/**
 * Stable `plugin_catalog.id`. The seeder derives ids as `catalog:${slug}`
 * (see `catalog-seeder.ts::upsertEntry`), so the FK target in
 * `workspace_plugins.catalog_id` is `catalog:openapi-generic`.
 */
export const OPENAPI_GENERIC_CATALOG_ID = "catalog:openapi-generic";

/** Friendly display name for the `/admin/connections` card + catalog listings. */
export const OPENAPI_GENERIC_NAME = "OpenAPI (Generic REST)";

export const OPENAPI_GENERIC_DESCRIPTION =
  "Connect any REST API with an OpenAPI 3.x spec as a datasource — read by " +
  "default, with an opt-in per-endpoint write allowlist (e.g. Twenty, Stripe, " +
  "an internal service). The agent discovers operations from the spec and " +
  "queries them directly.";

/**
 * Auth kinds the install form accepts. `oauth2` is declared (so the enum is
 * stable and the form can show it as coming-soon) but its flow is deferred to
 * slice 6 — the handler rejects it. Mirrors the PRD's `auth_kind` enum.
 */
export const OPENAPI_AUTH_KINDS = [
  "none",
  "bearer",
  "basic",
  "apikey-header",
  "apikey-query",
  "oauth2",
] as const;
export type OpenApiAuthKind = (typeof OPENAPI_AUTH_KINDS)[number];

/** Auth kinds an install can actually use this slice (oauth2 lands in slice 6). */
export const OPENAPI_SUPPORTED_AUTH_KINDS: ReadonlyArray<OpenApiAuthKind> = [
  "none",
  "bearer",
  "basic",
  "apikey-header",
  "apikey-query",
];

/**
 * The auth kinds an install can actually execute with — the {@link
 * OpenApiAuthKind} enum minus the declared-but-deferred `oauth2`. Modeling the
 * execution surface as its own type makes `buildResolvedAuth` total over it (no
 * runtime "unsupported kind" throw): callers narrow a form/DB-read kind through
 * {@link narrowSupportedAuthKind} first and handle the deferred case explicitly,
 * so an `oauth2` value is unrepresentable downstream of validation.
 */
export type SupportedAuthKind = Exclude<OpenApiAuthKind, "oauth2">;

/**
 * Narrow a raw auth-kind **string** (read back from a `workspace_plugins.config`
 * JSONB row, where the value is untyped at the trust boundary) to the executable
 * subset, or `null` when it isn't one. Returns `null` for BOTH the
 * declared-but-deferred `oauth2` (slice 6 #2930) AND any unrecognized/garbage
 * value a drifted or hand-edited row might carry — it validates **positive
 * membership** against {@link OPENAPI_SUPPORTED_AUTH_KINDS} rather than merely
 * excluding `oauth2`, so the caller's explicit `null` skip is what guards
 * `buildResolvedAuth` (no reliance on a thrown-and-caught "unsupported kind").
 * The install form rejects oauth2 at submit; the rediscover/resolve read paths
 * skip on `null`. Keep in lockstep with {@link OPENAPI_SUPPORTED_AUTH_KINDS} if
 * more kinds defer.
 */
export function narrowSupportedAuthKind(kind: string): SupportedAuthKind | null {
  return (OPENAPI_SUPPORTED_AUTH_KINDS as ReadonlyArray<string>).includes(kind)
    ? (kind as SupportedAuthKind)
    : null;
}

/** Default representation mode — the #2931 bake-off winner (Path A). */
export const DEFAULT_REPRESENTATION_MODE: RepresentationMode = "operation-graph";

/**
 * The install form's `config_schema`, exactly as the PRD specifies. The
 * `secret: true` flag on `auth_value` is the single thing that drives
 * `encryptSecretFields` / `decryptSecretFields` — adding a new auth field is a
 * one-line schema change, never a hand-wired encryption call (AC3, user story
 * 19). `write_allowlist` (and `side_effecting_operations`, #3008) are honored by
 * `validateRestOperation` (slice 5, #2929).
 *
 * `auth_kind` is a `select` so the admin UI renders a dropdown bound to
 * {@link OPENAPI_AUTH_KINDS}; the handler re-validates against
 * {@link OPENAPI_SUPPORTED_AUTH_KINDS}.
 */
export const OPENAPI_GENERIC_CONFIG_SCHEMA: ReadonlyArray<ConfigSchemaField> = [
  {
    key: "openapi_url",
    type: "string",
    label: "OpenAPI spec URL",
    required: true,
    description: "URL of the OpenAPI 3.x document, e.g. https://crm.example.com/rest/open-api/core",
  },
  {
    key: "auth_kind",
    type: "select",
    label: "Authentication",
    required: true,
    options: [...OPENAPI_AUTH_KINDS],
    default: "bearer",
    description: "How Atlas authenticates to the API. oauth2 is coming soon.",
  },
  {
    key: "auth_value",
    type: "string",
    label: "Token / API key / credential",
    secret: true,
    description:
      "Bearer token, API key, or `username:password` for basic auth. Encrypted at rest.",
  },
  {
    key: "auth_header_name",
    type: "string",
    label: "API key header name",
    description: "For apikey-header auth, e.g. X-API-Key.",
  },
  {
    key: "auth_param_name",
    type: "string",
    label: "API key query param",
    description: "For apikey-query auth, e.g. api_key.",
  },
  {
    key: "base_url_override",
    type: "string",
    label: "Base URL override",
    description: "When the spec's servers[0].url is wrong (dev/staging).",
  },
  {
    key: "write_allowlist",
    type: "string",
    label: "Write allowlist (JSON)",
    description:
      "JSON array of operationIds permitted to execute non-GET (write) requests, e.g. " +
      '["createOnePerson","createOneNote"]. Empty/omitted = read-only (default). Every ' +
      "allowlisted write still requires an in-chat confirm-before-write step before it fires.",
  },
  {
    key: "side_effecting_operations",
    type: "string",
    label: "Side-effecting GET operations (JSON)",
    description:
      "JSON array of operationIds whose GET/HEAD method MUTATES state (e.g. " +
      '["cancelJob"] for GET /jobs/{id}/cancel). Listing one forces it through the write ' +
      "allowlist + confirm flow, exactly like a POST. SECURITY: read vs write is classified by " +
      "HTTP method by DEFAULT — when a GET on this API changes data (common for legacy / RPC-style " +
      "services), you MUST list it here (or set x-atlas-side-effecting: true on the operation in " +
      "the spec), or the agent will run it as an unconfirmed read.",
  },
  {
    key: "display_name",
    type: "string",
    label: "Display name",
    description: "Friendly name shown in /admin/connections.",
  },
];

/**
 * The probed-spec snapshot cached in `workspace_plugins.config.openapi_snapshot`
 * (OQ4 default — per-tenant, never committed). Holds the raw OpenAPI document so
 * the resolver can rebuild the {@link OperationGraph} (the canonical
 * `buildOperationGraph` is the single source of truth — caching the doc, not a
 * serialized graph, avoids a second graph encoding that could drift). The
 * lightweight fields are denormalized for the detail page so it can list the
 * operation surface without rebuilding the graph on every read.
 *
 * `probedAt` is an ISO-8601 string — it's the trailing component of the
 * in-process graph-cache key (`${workspaceId}:${installId}:${probedAt}`) so a
 * "Rediscover schema" re-probe (which bumps it) lands under a fresh key.
 */
export interface OpenApiSnapshot {
  /** ISO-8601 timestamp of the probe. Trailing component of the graph-cache key. */
  readonly probedAt: string;
  /** Spec `info.title`, for the card/header. */
  readonly title: string;
  /** Spec `info.version`. */
  readonly version: string;
  /** Raw `openapi` version string, e.g. "3.1.0". */
  readonly openapiVersion: string;
  /** Count of discovered operations — sanity metric on the card. */
  readonly operationCount: number;
  /** The raw OpenAPI document the resolver rebuilds the graph from. */
  readonly doc: unknown;
}

/**
 * Runtime guard for a snapshot read back from `workspace_plugins.config` JSONB.
 * The config round-trips through JSONB as `Record<string, unknown>`, so the
 * `openapi_snapshot` field is untyped at the trust boundary — an older builder
 * or a drifted row could yield missing / wrong-typed fields that would otherwise
 * flow into the prompt header and admin card as `undefined` / `NaN`. Validate
 * the load-bearing fields here so a malformed snapshot is treated as "missing"
 * (skip / prompt a rediscover) — the same fail-soft posture as a row that has no
 * snapshot at all, instead of an unchecked `as OpenApiSnapshot` cast.
 */
export function isValidSnapshot(value: unknown): value is OpenApiSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.probedAt === "string" &&
    typeof s.title === "string" &&
    typeof s.version === "string" &&
    typeof s.openapiVersion === "string" &&
    typeof s.operationCount === "number" &&
    // The raw OpenAPI document is always a JSON object — reject a primitive,
    // `null`, or an array so `snapshotToGraph` never tries to rebuild from a
    // value that isn't a spec document.
    typeof s.doc === "object" &&
    s.doc !== null &&
    !Array.isArray(s.doc)
  );
}

/** A single discovered operation, for the detail page's operations table. */
export interface DiscoveredOperationSummary {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
}

/**
 * Resolve a representation-mode string from config to a typed
 * {@link RepresentationMode}, falling back to the bake-off default on an
 * unknown/absent value (a misconfigured toggle must never take the datasource
 * offline — same fail-soft posture as the slice-1 env resolver).
 */
export function coerceRepresentationMode(raw: unknown): RepresentationMode {
  if (typeof raw === "string" && (REPRESENTATION_MODES as readonly string[]).includes(raw)) {
    return raw as RepresentationMode;
  }
  return DEFAULT_REPRESENTATION_MODE;
}

/**
 * Parse the `write_allowlist` config value into the set of operationIds permitted
 * to write (slice 5, #2929). Accepts the form-stored JSON **string**
 * (`'["createOnePerson"]'`) or an already-parsed **array** (an `atlas.config.ts`
 * plugins entry). Anything else — a malformed JSON string, a non-array, a
 * non-string element — resolves to the **empty set (default-deny / read-only)**,
 * logged for the operator. A broken allowlist must never widen write access; it
 * fails closed, the same posture as the workspace resolver's other fields.
 */
export function parseWriteAllowlist(raw: unknown, installId?: string): ReadonlySet<string> {
  if (raw === undefined || raw === null || raw === "") return new Set();

  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      log.warn(
        { installId },
        "OpenAPI install write_allowlist is not valid JSON — treating as read-only (default-deny)",
      );
      return new Set();
    }
  }

  if (!Array.isArray(value)) {
    log.warn(
      { installId },
      "OpenAPI install write_allowlist is not a JSON array — treating as read-only (default-deny)",
    );
    return new Set();
  }

  const ops = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) ops.add(item);
  }
  if (ops.size !== value.length) {
    log.warn(
      { installId },
      "OpenAPI install write_allowlist contained non-string / empty entries — they were ignored",
    );
  }
  return ops;
}

/**
 * Parse the `side_effecting_operations` config value (#3008): operationIds whose
 * read-method (GET/HEAD) MUTATES state and must therefore be forced through the
 * write allowlist + confirm path (the per-spec `x-atlas-side-effecting: true`
 * extension does the same per-operation). Accepts the form-stored JSON **string**
 * (`'["cancelJob"]'`) or an already-parsed **array** (an `atlas.config.ts` plugins
 * entry); anything malformed resolves to the **empty set** — classification stays
 * method-only — logged for the operator.
 *
 * NOTE: degrading-to-empty here is NOT "fail-closed" in the {@link
 * parseWriteAllowlist} sense, and the security semantics are inverted. An empty
 * *allowlist* means default-deny writes (safe); an empty *side-effecting list*
 * means a GET the operator INTENDED to gate is left classified as a plain read
 * and runs unconfirmed (the less-safe outcome for that operation). We degrade to
 * empty + warn rather than throw because the config is a free-text JSON blob — we
 * can't infer which ops a malformed list meant, and a hard throw would take the
 * whole datasource offline for one fat-fingered entry. The operator must fix the
 * config; the warn log surfaces it. (Contrast the spec extension, a single named
 * scalar the parser CAN pinpoint and so rejects loudly — see {@link
 * import("./spec").buildOperationGraph}.)
 */
export function parseSideEffectingOperations(raw: unknown, installId?: string): ReadonlySet<string> {
  if (raw === undefined || raw === null || raw === "") return new Set();

  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      log.warn(
        { installId },
        "OpenAPI install side_effecting_operations is not valid JSON — ignoring (classification stays method-only)",
      );
      return new Set();
    }
  }

  if (!Array.isArray(value)) {
    log.warn(
      { installId },
      "OpenAPI install side_effecting_operations is not a JSON array — ignoring (classification stays method-only)",
    );
    return new Set();
  }

  const ops = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) ops.add(item);
  }
  if (ops.size !== value.length) {
    log.warn(
      { installId },
      "OpenAPI install side_effecting_operations contained non-string / empty entries — they were ignored",
    );
  }
  return ops;
}

// ─────────────────────────────────────────────────────────────────────
//  Per-install numeric overrides — rate limit + request timeout
//
//  FORWARD SEAM (#3009): the two parsers below READ `rate_limit_per_minute` /
//  `request_timeout_ms` off the decrypted install config, surface them on
//  {@link import("./datasource").RestDatasource}, and `validateRestOperation`
//  already enforces them (per-op token bucket + the timeout cap). But Atlas
//  ships NO write surface for them today: they're absent from
//  {@link OPENAPI_GENERIC_CONFIG_SCHEMA}, the install form
//  (`openapi-generic-form-handler.ts`), the admin PATCH route, and migration
//  0108 — so in practice both resolve to `undefined` (the defaults apply) and the
//  validator's cap branches are exercised only by tests / a hand-written config
//  row. The read side is kept wired (mirrors how `representation.ts` keeps
//  `pythonCompositionEnabled` as a dormant seam): lighting it up is a purely
//  additive change — add the two keys to the schema + a form field + a PATCH
//  branch — with no parser/validator rework. Until then this is intentional dead
//  config, not an oversight.
// ─────────────────────────────────────────────────────────────────────

/** Coerce a positive-integer config override (calls/min, ms, …) or `undefined`. */
function parsePositiveIntConfig(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve a per-install rate-limit override (calls/min) from config, or
 * `undefined` to use the {@link RestDatasource} default. A non-positive /
 * non-numeric value is ignored (fall back to the default) rather than throttling
 * to zero — but the dropped override is logged for parity with
 * {@link parseWriteAllowlist}, so a fat-fingered value isn't silently swallowed.
 */
export function parseRateLimitPerMinute(raw: unknown, installId?: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = parsePositiveIntConfig(raw);
  if (parsed === undefined) {
    log.warn(
      { installId, value: raw },
      "OpenAPI install rate_limit_per_minute is not a positive number — using the default (60/min)",
    );
  }
  return parsed;
}

/**
 * Resolve a per-install request-timeout override (ms) from config, or `undefined`
 * to use the `ATLAS_OPENAPI_TIMEOUT` cap. `validateRestOperation` rejects a value
 * above the cap (`timeout-exceeded`); a non-positive / non-numeric value is
 * dropped (warned) and the cap applies.
 */
export function parseRequestTimeoutMs(raw: unknown, installId?: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = parsePositiveIntConfig(raw);
  if (parsed === undefined) {
    log.warn(
      { installId, value: raw },
      "OpenAPI install request_timeout_ms is not a positive number — using the ATLAS_OPENAPI_TIMEOUT cap",
    );
  }
  return parsed;
}
