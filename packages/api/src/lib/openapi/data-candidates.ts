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
 * (`data-candidate-seed.ts`) re-asserts every row idempotently; migrations
 * 0109 (stripe-data) / 0110 (notion-data) / 0111 (github-data) insert them on
 * fresh DBs. An install writes a `workspace_plugins` row
 * under the candidate's {@link DataCandidate.catalogId}; the workspace resolver
 * (`workspace-datasource.ts`) matches those ids alongside `openapi-generic` and
 * attaches the candidate's {@link DataCandidate.quirk} to the resolved
 * {@link import("./datasource").RestDatasource}.
 */
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import type { CatalogInstallModel } from "@useatlas/types";
import type { SupportedAuthKind } from "./catalog";
import type { PaginationConfig } from "./paginator";
import type { VendorQuirk } from "./vendor-quirk";

/**
 * Fields shared by every built-in vendor REST datasource, pre-wired over the
 * generic primitive. The `slug` / `catalogId` follow the same `catalog:${slug}`
 * derivation the seeder uses for every catalog row (so
 * `workspace_plugins.catalog_id` FK-targets e.g. `catalog:stripe-data`).
 */
export interface BaseDataCandidate {
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
  /**
   * The candidate's real API base URL (host), e.g. `https://api.stripe.com`.
   * Used SOLELY to gate the install-time probe credential (#3034) — only its HOST
   * is consulted, and NOT at query time (the executable base URL is re-derived from
   * the spec's `servers[]` / `base_url_override`; see `workspace-datasource.ts`).
   * The probe credential is sent to {@link openapiUrl} iff the two share a host.
   * Today every built-in candidate pins its spec to a public host
   * (raw.githubusercontent.com) while its API lives elsewhere, so for them this
   * differs from {@link openapiUrl}'s host — exactly the case the gate is designed
   * to catch (withhold the credential from the spec host). An admin
   * `base_url_override` takes precedence over this at probe time.
   */
  readonly apiBaseUrl: string;
  /**
   * Declarative deviations the generic client applies per request (required
   * static headers / query param-shaping). Omit for a perfectly-generic API.
   */
  readonly quirk?: VendorQuirk;
  /**
   * Default pagination config for the candidate's list operations, resolved
   * against the SAME `defaultPaginatorRegistry` (no new strategy file).
   * Forward-looking: the live tool calls the un-paginated primitive today
   * (`executeOperationPaged` is dormant, see paginator.test.ts) — this is what
   * wires in when pagination reaches the tool (#2970).
   */
  readonly pagination?: PaginationConfig;
  /**
   * `operationId`s whose POST is a GENUINE READ (#3035) — e.g. Notion's
   * workspace search, `POST /v1/search`. The validator gates every non-GET/HEAD
   * as a write, so without this a vendor's read-over-POST surface is unreachable
   * on a default install (empty write allowlist → `writes-disabled`). The
   * resolver threads this onto the {@link import("./datasource").RestDatasource}
   * (`readSafePostOperations`) so {@link
   * import("./validate-rest-operation").isSideEffectingOperation} DEMOTES the POST
   * to a read — it passes the read gate WITHOUT an admin write-allowlist edit.
   *
   * This is a curated VENDOR FACT, in code (the admin shouldn't need Notion API
   * expertise). It is strictly a safety-DROP: an `x-atlas-side-effecting` spec
   * extension or a per-install `side_effecting_operations` entry always overrides
   * it (escalation wins), and the demotion is POST-only. The slice-2 (#2926)
   * per-operation override remains the per-INSTALL escape hatch; this is the
   * candidate-level default. Omit for a candidate with no read-over-POST surface.
   */
  readonly readSafePostOperations?: ReadonlyArray<string>;
}

/**
 * A FORM candidate (Stripe, Notion): the admin pastes a static credential. The
 * `install_model` is `form`; the install handler pre-fills `openapiUrl` +
 * `authKind` from here so the admin supplies only the credential value.
 */
export interface FormDataCandidate extends BaseDataCandidate {
  /** Omitted = the default `form` install model. */
  readonly installModel?: "form";
  /** Pre-filled auth kind — the admin only supplies the credential value. */
  readonly authKind: SupportedAuthKind;
  /**
   * Never set on a form candidate — its credential is a static form field, not
   * an OAuth dance. Present as `?: never` so the union makes the both-fields
   * combination (`authKind` + `credentialMode`) a compile error rather than a
   * convention the JSDoc only asserts.
   */
  readonly credentialMode?: never;
}

/**
 * An OAUTH-DATASOURCE candidate (GitHub, v0.0.2 slice 6c #3030): the credential
 * is acquired via an OAuth dance, not a pasted secret, and minted on demand at
 * query time. The install model is `oauth-datasource` (a NEW handler family —
 * see `oauth-datasource-handler.ts`). `credentialMode` tells the workspace
 * resolver HOW to produce the executable bearer credential.
 */
export interface OAuthDatasourceDataCandidate extends BaseDataCandidate {
  readonly installModel: "oauth-datasource";
  /**
   * How the query-time resolver turns the persisted credential into a bearer
   * token. `github-app-installation` = mint an installation token from the App
   * JWT + the stored `installation_id` (`github/installation-token.ts`), cached
   * + re-minted on ~1hr expiry.
   */
  readonly credentialMode: "github-app-installation";
  /**
   * Never set on an oauth-datasource candidate — its credential comes from the
   * OAuth dance, not a static `authKind`. `?: never` makes a candidate that
   * declares both an OAuth credential mode and a static auth kind unrepresentable.
   */
  readonly authKind?: never;
}

/**
 * A built-in vendor REST datasource. Discriminated on `installModel` — a `form`
 * candidate carries a static `authKind`; an `oauth-datasource` candidate carries
 * a `credentialMode` instead (its credential comes from the OAuth dance).
 */
export type DataCandidate = FormDataCandidate | OAuthDatasourceDataCandidate;

/** The catalog `install_model` for a candidate (`form` unless overridden). */
export function candidateInstallModel(candidate: DataCandidate): CatalogInstallModel {
  return candidate.installModel ?? "form";
}

/** Narrow to an OAuth-datasource candidate (credential via OAuth, not a form field). */
export function isOAuthDatasourceCandidate(
  candidate: DataCandidate,
): candidate is OAuthDatasourceDataCandidate {
  return candidate.installModel === "oauth-datasource";
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
      "The API credential for this datasource (e.g. a secret API key or access token). Encrypted at rest.",
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
 * The install-form `config_schema` for an OAUTH-DATASOURCE candidate (github-data,
 * #3030). DELIBERATELY EMPTY: the credential is acquired via the OAuth dance, not
 * a form field — the admin only clicks "Connect", so there is nothing to render.
 * The persisted credential's encryption is driven by a code-resident schema
 * (`GITHUB_APP_SECRET_FIELDS_SCHEMA`, `installation_id` secret), NOT this catalog
 * form schema.
 */
export const OAUTH_DATASOURCE_CONFIG_SCHEMA: ReadonlyArray<ConfigSchemaField> = [];

/**
 * The catalog `config_schema` (admin form) for a candidate. Form candidates share
 * the credential form; oauth-datasource candidates have no form fields.
 */
export function candidateConfigSchema(
  candidate: DataCandidate,
): ReadonlyArray<ConfigSchemaField> {
  return isOAuthDatasourceCandidate(candidate)
    ? OAUTH_DATASOURCE_CONFIG_SCHEMA
    : DATA_CANDIDATE_CONFIG_SCHEMA;
}

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
export const STRIPE_DATA_CANDIDATE: FormDataCandidate = {
  slug: "stripe-data",
  catalogId: "catalog:stripe-data",
  name: "Stripe",
  description:
    "Query your Stripe account (customers, charges, invoices, subscriptions, …) as a read-only " +
    "REST datasource. Pre-wired to Stripe's published OpenAPI spec — paste your secret key, no " +
    "spec URL needed. The agent discovers operations from the spec and queries them directly.",
  openapiUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  // The spec is on GitHub; the API (and the only host the secret key may reach) is
  // api.stripe.com — so the host-match gate (#3034) withholds the key from the
  // spec fetch and only sends it at query time.
  apiBaseUrl: "https://api.stripe.com",
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

/**
 * GitHub — the OAuth2 data candidate (#3030; the OQ5 deliverable). Proves the
 * OAuth dimension of the generic primitive:
 *  - OAuth2 credential acquisition via GitHub's EXISTING App registration (no new
 *    vendor app) — install handler `oauth-datasource-handler.ts`,
 *  - `Link`-header pagination — ALREADY a generic strategy (`strategies/link-header.ts`),
 *    so github-data is a thin wrapper (OQ6): no GitHub-specific walker/paginator/
 *    validator. The GitHub-ness lives only in the install handler + the
 *    credential resolver, never the query path.
 *
 * The credential is the App `installation_id`; the executable bearer token is
 * minted on demand from the App JWT (`credentialMode: "github-app-installation"`)
 * and re-minted transparently on ~1hr expiry — NOT a refresh-token rotation.
 *
 * NOTE (generalization watch, #2930 AC): GitHub's published OpenAPI document is
 * large; probe-on-install fetches + snapshots it into `workspace_plugins.config`.
 * If the full spec proves too big to snapshot in practice, the follow-up is a
 * size cap or a curated subset URL — filed rather than forked (the walker/
 * paginator/validator stay generic).
 */
export const GITHUB_DATA_CANDIDATE: OAuthDatasourceDataCandidate = {
  slug: "github-data",
  catalogId: "catalog:github-data",
  name: "GitHub",
  description:
    "Query your GitHub organization (repositories, pull requests, issues, …) as a read-only REST " +
    "datasource. Connects through your GitHub App installation — no token to paste. The agent " +
    "discovers operations from GitHub's published OpenAPI spec and queries them directly, " +
    "following Link-header pagination.",
  openapiUrl:
    "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
  // The published spec is on GitHub's raw CDN; the API host is api.github.com.
  // github-data probes with `{ kind: "none" }` (no credential at probe — the
  // installation token is minted at query time), so the gate is moot here, but the
  // real API host is declared for accuracy + the host-match contract (#3034).
  apiBaseUrl: "https://api.github.com",
  installModel: "oauth-datasource",
  credentialMode: "github-app-installation",
  pagination: {
    // GitHub list endpoints return a TOP-LEVEL array (no wrapper), so `itemsPath`
    // is omitted (defaults to the response root). Next-page URL comes from the
    // RFC 8288 `Link: …; rel="next"` header — the existing generic strategy.
    strategy: "link-header",
  },
};

/**
 * Notion — the second data candidate (#3029, slice 6b). The **required-static-
 * header** proof: a per-vendor header (`Notion-Version`) that nothing else in the
 * candidate set exercises and that NO part of the OpenAPI document can express as
 * "send on every request". The spec models it as an OPTIONAL header parameter with
 * a default; the generic client never auto-sends a param default, and the agent
 * constructing a call won't set it — so it MUST be supplied by the declarative
 * {@link VendorQuirk.requiredHeaders}, applied on every request (including every
 * page of a cursor walk) with NO Notion-specific code branch. Dimensions:
 *  - `bearer` auth (the Notion integration token, sent as `Authorization: Bearer …`),
 *  - the required `Notion-Version` header (the dimension this candidate proves),
 *  - cursor pagination via the existing `cursor` strategy — Notion's BODY-cursor
 *    dialect: the response body carries `next_cursor` + a top-level `has_more`,
 *    fed back on the `start_cursor` query param (the strategy's `cursorPath` +
 *    `hasMorePath`, a DIFFERENT dialect than Stripe's last-item-id, same file).
 *
 * The pinned `Notion-Version` (`2025-09-03`) matches the spec edition the
 * {@link openapiUrl} serves (makenotion/notion-mcp-server's "Data Source Edition")
 * — header and spec must agree, since that edition's data-source endpoints require
 * the matching version. The body-cursor default targets Notion's GET list surface
 * (`get-users`, `get-block-children`, `retrieve-a-comment`); the POST `post-search`
 * endpoint behind "list pages in my workspace" carries its cursor in the body, a
 * per-operation override that arrives with slice 2 (#2926) — its first page (≤100
 * results) returns un-paginated today.
 */
export const NOTION_DATA_CANDIDATE: DataCandidate = {
  slug: "notion-data",
  catalogId: "catalog:notion-data",
  name: "Notion",
  description:
    "Query your Notion workspace (pages, databases, users, comments, …) as a read-only REST " +
    "datasource. Pre-wired to Notion's published OpenAPI spec — paste your integration token, no " +
    "spec URL needed. The agent discovers operations from the spec and queries them directly.",
  openapiUrl:
    "https://raw.githubusercontent.com/makenotion/notion-mcp-server/main/scripts/notion-openapi.json",
  // The spec is on GitHub; the API (and the only host the integration token may
  // reach) is api.notion.com — the host-match gate (#3034) withholds the token
  // from the spec fetch.
  apiBaseUrl: "https://api.notion.com",
  authKind: "bearer",
  quirk: {
    // Notion mandates a version header on every request; the spec declares it as an
    // optional `in: header` param with a default, which the client never auto-sends.
    // The quirk supplies it as a non-clobbering default on every call. DATA, not a
    // code branch — pinned to the spec edition `openapiUrl` serves.
    requiredHeaders: { "Notion-Version": "2025-09-03" },
  },
  pagination: {
    strategy: "cursor",
    itemsPath: "results",
    cursorParam: "start_cursor",
    // Body-cursor dialect: the next cursor is the response body's `next_cursor`
    // (vs Stripe's last list item id), with a top-level `has_more` flag.
    cursorPath: "next_cursor",
    hasMorePath: "has_more",
  },
  // #3035: Notion's "list pages in my workspace" is `POST /v1/search` — a genuine
  // READ. The validator gates every non-GET as a write, so without declaring it
  // read-safe `post-search` would be unreachable on a default install (empty write
  // allowlist). This is a curated vendor fact, in code: the resolver demotes it to a
  // read so it passes the read gate with no admin write-allowlist edit. Genuine
  // Notion writes (create/update pages) stay gated behind allowlist + confirm.
  readSafePostOperations: ["post-search"],
};

/** Every built-in data candidate. Append a new vendor here (the one-line thesis). */
export const DATA_CANDIDATES: ReadonlyArray<DataCandidate> = [
  STRIPE_DATA_CANDIDATE,
  GITHUB_DATA_CANDIDATE,
  NOTION_DATA_CANDIDATE,
];

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
