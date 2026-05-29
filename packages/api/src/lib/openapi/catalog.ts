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

import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { CatalogId } from "@atlas/api/lib/integrations/install/types";
import { REPRESENTATION_MODES, type RepresentationMode } from "./representation";

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
  "Connect any REST API with an OpenAPI 3.x spec as a read-only datasource " +
  "(e.g. Twenty, Stripe, an internal service). The agent discovers operations " +
  "from the spec and queries them directly.";

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
 * Narrow a raw {@link OpenApiAuthKind} to the executable subset, or `null` for a
 * declared-but-deferred kind (`oauth2`, slice 6 #2930). The install form rejects
 * oauth2 at submit; the rediscover/resolve read paths (which read the kind back
 * from the DB, where a drifted row could carry oauth2) skip or 400 on `null`
 * rather than relying on a thrown-and-caught error. Keep in lockstep with
 * {@link OPENAPI_SUPPORTED_AUTH_KINDS} if more kinds defer.
 */
export function narrowSupportedAuthKind(kind: OpenApiAuthKind): SupportedAuthKind | null {
  return kind === "oauth2" ? null : kind;
}

/** Default representation mode — the #2931 bake-off winner (Path A). */
export const DEFAULT_REPRESENTATION_MODE: RepresentationMode = "operation-graph";

/**
 * The install form's `config_schema`, exactly as the PRD specifies. The
 * `secret: true` flag on `auth_value` is the single thing that drives
 * `encryptSecretFields` / `decryptSecretFields` — adding a new auth field is a
 * one-line schema change, never a hand-wired encryption call (AC3, user story
 * 19). `write_allowlist` is captured but only honored in slice 5 (#2929).
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
    description: "JSON array of operationIds permitted to write. Honored in a later release.",
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
 * `probedAt` is an ISO-8601 string — it doubles as the in-process graph-cache
 * key so a "Rediscover schema" re-probe invalidates the cached graph.
 */
export interface OpenApiSnapshot {
  /** ISO-8601 timestamp of the probe. Also the in-process graph cache key. */
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
    s.doc !== undefined
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
