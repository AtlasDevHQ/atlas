/**
 * `data-candidates` — the declarative registry of built-in vendor `*-data` REST
 * Datasource catalog rows (v0.0.2 slice 6a, #3028; the foundational pattern
 * #3029 / #3030 extend).
 *
 * ## What a "data candidate" is
 * A thin, pre-wired wrapper over the SAME generic OpenAPI primitive the
 * `openapi-generic` catalog row exposes (`catalog.ts`). The generic row makes an
 * admin paste a spec URL + pick an auth kind; a data candidate pre-fills both
 * from this registry so the admin installs "Stripe" by pasting only their secret
 * key — no spec URL, no auth-kind dropdown. Everything else (probe, snapshot,
 * operation graph, validator, paginator, client) is the unchanged generic
 * machinery — there is NO forked walker / paginator / validator per vendor. The
 * only vendor-specific data is:
 *   - the pre-filled {@link DataCandidate.openapiUrl} + {@link DataCandidate.authKind},
 *   - an optional declarative {@link DataCandidate.quirk} (required headers /
 *     query param-shaping the generic client applies, see `vendor-quirk.ts`),
 *   - an optional default {@link DataCandidate.pagination} config (resolved
 *     against the SAME `defaultPaginatorRegistry` — no new strategy file).
 *
 * Adding a candidate is one entry in {@link DATA_CANDIDATES} (~a dozen lines) +
 * a one-row migration mirroring this registry. That is the "thin catalog-seed
 * wrapper (~50 LoC) over the generic primitive" thesis #2930 set.
 *
 * ## Seeding + resolution
 * Each candidate is a real `plugin_catalog` row (datasource pillar) so it surfaces
 * in `/admin/connections` as its own installable card. The boot seed
 * (`data-candidate-seed.ts`) re-asserts every row idempotently; migration
 * 0109 inserts them on fresh DBs. An install writes a `workspace_plugins` row
 * under the candidate's {@link DataCandidate.catalogId}; the workspace resolver
 * (`workspace-datasource.ts`) matches those ids alongside `openapi-generic` and
 * attaches the candidate's {@link DataCandidate.quirk} to the resolved
 * {@link import("./datasource").RestDatasource}.
 */
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { SupportedAuthKind } from "./catalog";
import type { PaginationConfig } from "./paginator";
import type { VendorQuirk } from "./vendor-quirk";

/**
 * A built-in vendor REST datasource, pre-wired over the generic primitive. The
 * `slug` / `catalogId` follow the same `catalog:${slug}` derivation the seeder
 * uses for every catalog row (so `workspace_plugins.catalog_id` FK-targets
 * `catalog:stripe-data`).
 */
export interface DataCandidate {
  /** Catalog slug + install-handler dispatch key, e.g. "stripe-data". */
  readonly slug: string;
  /** Stable `plugin_catalog.id` (`catalog:${slug}`), the FK target. */
  readonly catalogId: string;
  /** Friendly card name in `/admin/connections`, e.g. "Stripe". */
  readonly name: string;
  /** Card description. */
  readonly description: string;
  /** Pre-filled OpenAPI 3.x spec URL — the admin never pastes this. */
  readonly openapiUrl: string;
  /** Pre-filled auth kind — the admin only supplies the credential value. */
  readonly authKind: SupportedAuthKind;
  /**
   * Declarative deviations the generic client applies per request (required
   * static headers / query param-shaping). Omit for a perfectly-generic API.
   */
  readonly quirk?: VendorQuirk;
  /**
   * Default pagination config for the candidate's list operations, resolved
   * against the SAME `defaultPaginatorRegistry` (no new strategy file). Stripe's
   * whole list surface uses one cursor dialect, so a single default suffices.
   * Forward-looking: the live tool calls the un-paginated primitive today
   * (`executeOperationPaged` is dormant, see paginator.test.ts) — this is what
   * wires in when pagination reaches the tool (#2970).
   */
  readonly pagination?: PaginationConfig;
}

/**
 * The install-form `config_schema` shared by EVERY data-candidate row. The admin
 * supplies only the credential (+ optional overrides) — `openapi_url` and
 * `auth_kind` are pre-filled from the {@link DataCandidate} by the install
 * handler, so they are deliberately ABSENT here (a candidate install must never
 * let the admin re-point the locked spec URL). `auth_value`'s `secret: true` is
 * the single flag that drives `encryptSecretFields` — same one-line-to-add-a-
 * secret contract as the generic schema.
 */
export const DATA_CANDIDATE_CONFIG_SCHEMA: ReadonlyArray<ConfigSchemaField> = [
  {
    key: "auth_value",
    type: "string",
    label: "API key / token",
    required: true,
    secret: true,
    description:
      "The API credential for this datasource (e.g. your Stripe secret key). Encrypted at rest.",
  },
  {
    key: "base_url_override",
    type: "string",
    label: "Base URL override",
    description: "When the spec's servers[0].url is wrong (dev/staging/regional host).",
  },
  {
    key: "display_name",
    type: "string",
    label: "Display name",
    description: "Friendly name shown in /admin/connections.",
  },
];

/**
 * Stripe — the first data candidate (#3028). Proves three dimensions the
 * candidate set deliberately spans:
 *  - `bearer` auth (the secret key, sent as `Authorization: Bearer …`),
 *  - the `expand[]` query quirk (Stripe's bracket-array form encoding),
 *  - cursor pagination via the existing `cursor` strategy — Stripe's cursor is
 *    the LAST returned object's `id` fed back as `starting_after`, with a
 *    top-level `has_more` flag (handled by the strategy's `cursorFromLastItem` +
 *    `hasMorePath`, no new strategy file).
 */
export const STRIPE_DATA_CANDIDATE: DataCandidate = {
  slug: "stripe-data",
  catalogId: "catalog:stripe-data",
  name: "Stripe",
  description:
    "Query your Stripe account (customers, charges, invoices, subscriptions, …) as a read-only " +
    "REST datasource. Pre-wired to Stripe's published OpenAPI spec — paste your secret key, no " +
    "spec URL needed. The agent discovers operations from the spec and queries them directly.",
  openapiUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  authKind: "bearer",
  quirk: {
    // Stripe wants array params as `expand[]=a&expand[]=b`; the spec declares a
    // bare `expand` (style: deepObject, explode: true), so the `[]` is a shaping
    // rule, not graph data.
    queryParamShaping: [{ param: "expand", bracketArray: true }],
  },
  pagination: {
    strategy: "cursor",
    itemsPath: "data",
    cursorParam: "starting_after",
    // Stripe has no `endCursor` field — the next cursor is the last list item's id.
    cursorFromLastItem: true,
    cursorItemField: "id",
    hasMorePath: "has_more",
  },
};

/** Every built-in data candidate. Append a new vendor here (the one-line thesis). */
export const DATA_CANDIDATES: ReadonlyArray<DataCandidate> = [STRIPE_DATA_CANDIDATE];

const BY_CATALOG_ID = new Map<string, DataCandidate>(
  DATA_CANDIDATES.map((c) => [c.catalogId, c]),
);
const BY_SLUG = new Map<string, DataCandidate>(DATA_CANDIDATES.map((c) => [c.slug, c]));

/** The catalog ids the workspace resolver must match alongside `openapi-generic`. */
export const DATA_CANDIDATE_CATALOG_IDS: ReadonlyArray<string> = DATA_CANDIDATES.map(
  (c) => c.catalogId,
);

/** Look up a candidate by its `plugin_catalog.id` (resolver path), or `undefined`. */
export function findDataCandidateByCatalogId(catalogId: string): DataCandidate | undefined {
  return BY_CATALOG_ID.get(catalogId);
}

/** Look up a candidate by its slug (install-handler registration path), or `undefined`. */
export function findDataCandidateBySlug(slug: string): DataCandidate | undefined {
  return BY_SLUG.get(slug);
}
