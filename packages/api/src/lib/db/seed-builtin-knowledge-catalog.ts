/**
 * Boot-time idempotent seed pass for the built-in Knowledge Base catalog rows
 * — the upload/bundle-sync arms plus the vendor connectors (Notion, Confluence,
 * GitBook). `BUILTIN_KNOWLEDGE_CATALOG_ROWS` is the authoritative list; adding a
 * connector is one append there, so this header stays non-enumerating.
 *
 * The Knowledge Base lifecycle (ADR-0028 §5) started as one built-in catalog
 * row — `okf-upload`, an **explicit, degenerate form install** with no
 * credentials and minimal `config_schema`. #4211 adds the generic sync arm,
 * `bundle-sync`: a form install whose config carries a bundle endpoint URL and
 * whose optional auth secret is the first Knowledge Base credential (dedicated
 * `knowledge_sync_credentials` table, an `INTEGRATION_TABLES` participant).
 * Installing either creates a *collection* (a `workspace_plugins` row, pillar
 * `knowledge`); ingest is a separate act (admin upload / scheduled pull). Per
 * ADR-0028 §5 the rows ship inside Atlas and are operator-curated — not
 * declared in `atlas.config.ts` — so they are seeded here at boot through the
 * operator-curated seam (`assertOperatorCatalogWrite`,
 * `lib/plugins/catalog-provenance.ts`), exactly mirroring the built-in
 * Datasource catalog seed.
 *
 * The rows' `pillar = 'knowledge'` is admitted by migration 0161's widened
 * CHECK, which `Migration` guarantees has run before this seed (the Layer's
 * `Migration` dependency).
 *
 * Idempotency: unqualified `ON CONFLICT DO NOTHING` covers both the `slug`
 * unique index and the `id` primary key, so re-running on a populated catalog
 * is a no-op. A seed-time failure logs at error and the API keeps booting —
 * the rows from a prior boot answer admin-UI reads.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { CONFLUENCE_CATALOG_ID, CONFLUENCE_SLUG } from "@atlas/api/lib/knowledge/confluence/config";
import {
  NOTION_KNOWLEDGE_CATALOG_ID,
  NOTION_KNOWLEDGE_SLUG,
} from "@atlas/api/lib/knowledge/notion/connector";
import { GITBOOK_CATALOG_ID, GITBOOK_SLUG } from "@atlas/api/lib/knowledge/gitbook/config";
import type { ConfigSchemaField } from "@atlas/api/lib/plugins/registry";
import { assertOperatorCatalogWrite } from "@atlas/api/lib/plugins/catalog-provenance";

const log = createLogger("db.seed-builtin-knowledge-catalog");

/**
 * Declarative description of the built-in Knowledge Base catalog row.
 * Mirrors `plugin_catalog`'s column shape for the columns the seed sets.
 * `type` (`context`), `pillar` (`knowledge`), `implementation_status`
 * (`available`), `min_plan` (`starter`), and `enabled` (`true`) are pinned
 * as SQL literals in the INSERT.
 */
export interface BuiltinKnowledgeCatalogRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly installModel: "form";
  readonly autoInstall: boolean;
  readonly saasEligible: boolean;
  readonly configSchema: ReadonlyArray<ConfigSchemaField>;
}

/**
 * The v0 built-in Knowledge Base catalog row (ADR-0028 §5). A
 * credential-less form install: the only config field is an optional
 * human description of the collection. The collection's identity is the
 * install slug chosen at install time, not a config field.
 */
export const BUILTIN_KNOWLEDGE_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: "catalog:okf-upload",
  slug: "okf-upload",
  name: "Knowledge Base (Upload)",
  description:
    "Upload an Open Knowledge Format bundle as a review-gated knowledge collection.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

/**
 * The generic bundle-sync Knowledge Base catalog row (#4211). A form install
 * whose collection pulls a bundle endpoint (any URL serving a `.tar` /
 * `.tar.gz` / `.zip` — including GitHub/GitLab repo-archive URLs) on the
 * Scheduler cadence and re-runs the #4207 ingest, so the diff is computed by
 * upsert-by-path and every synced change lands `draft` (ADR-0028 §4 — no
 * upload-&-publish shortcut for connector-style ingest).
 *
 * The `auth_secret` field is `secret: true` but is NOT stored in
 * `workspace_plugins.config` — the install handler routes it to the dedicated
 * `knowledge_sync_credentials` table (encrypted via `db/secret-encryption.ts`,
 * an `INTEGRATION_TABLES` participant). The flag still matters: it tells the
 * admin form to render a password input and never echo the value back.
 */
export const BUILTIN_BUNDLE_SYNC_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: "catalog:bundle-sync",
  slug: "bundle-sync",
  name: "Knowledge Base (Bundle Sync)",
  description:
    "Point a knowledge collection at an endpoint serving your bundle (tarball/zip, incl. git-forge archive URLs); Atlas pulls it on a schedule and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "endpoint_url",
      type: "string",
      label: "Endpoint URL",
      required: true,
      description:
        "HTTPS URL serving the knowledge bundle as .tar, .tar.gz, or .zip — e.g. a GitHub repo archive URL.",
    },
    {
      key: "auth_scheme",
      type: "select",
      label: "Authentication",
      options: [
        { value: "none", label: "None (public endpoint)" },
        { value: "bearer", label: "Bearer token" },
        { value: "basic", label: "Basic (user:password)" },
      ],
      default: "none",
      description: "How Atlas authenticates to a private endpoint.",
    },
    {
      key: "auth_secret",
      type: "string",
      secret: true,
      label: "Auth secret",
      description:
        "Bearer token, or user:password for basic auth. Stored encrypted; never returned.",
      showWhen: { field: "auth_scheme", equals: ["bearer", "basic"] },
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

/**
 * The Notion Knowledge Sync Connector catalog row (#4378, PRD #4375). A form
 * install whose only inputs are an internal-integration token and an optional
 * description — Notion's scope IS the set of pages the customer shares with the
 * integration (one collection per authorization), so there is no space/endpoint
 * field. Atlas syncs on the Scheduler via the shared connector engine; every
 * synced page lands `draft` behind the review gate.
 *
 * The `integration_token` field is `secret: true` but is NOT stored in
 * `workspace_plugins.config` — the install handler routes it to the dedicated
 * `knowledge_sync_credentials` table (encrypted). The flag tells the admin form
 * to render a password input and never echo the value back. The id/slug are the
 * connector-module SSOT (`NOTION_KNOWLEDGE_CATALOG_ID` / `NOTION_KNOWLEDGE_SLUG`).
 */
export const BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: NOTION_KNOWLEDGE_CATALOG_ID,
  slug: NOTION_KNOWLEDGE_SLUG,
  name: "Knowledge Base (Notion)",
  description:
    "Connect a Notion workspace with an internal-integration token; the pages you share with the integration sync as review-gated knowledge documents. Share a parent page to include its whole subtree.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "integration_token",
      type: "string",
      secret: true,
      label: "Internal-integration token",
      required: true,
      description:
        "A Notion internal-integration token (notion.so/my-integrations). Share the pages you want synced with this integration. Stored encrypted; never returned.",
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

/**
 * The Confluence Cloud connector Knowledge Base catalog row (#4377, PRD #4375).
 * A form install that mirrors ONE Confluence space into a review-gated
 * collection; the Scheduler dispatches the registered Confluence connector on a
 * cadence (incremental + reconciliation) and every synced page lands `draft`.
 *
 * `api_token` is `secret: true` but is NOT stored in `workspace_plugins.config`
 * — the install handler routes it to `knowledge_sync_credentials` (encrypted).
 * The base URL is customer-supplied, so every fetch goes through the SSRF egress
 * guard. The id/slug are the config SSOT (`CONFLUENCE_CATALOG_ID` /
 * `CONFLUENCE_SLUG`).
 */
export const BUILTIN_CONFLUENCE_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: CONFLUENCE_CATALOG_ID,
  slug: CONFLUENCE_SLUG,
  name: "Knowledge Base (Confluence Cloud)",
  description:
    "Mirror a Confluence Cloud space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "base_url",
      type: "string",
      label: "Confluence site URL",
      required: true,
      description:
        "Your Confluence Cloud site URL, e.g. https://your-team.atlassian.net/wiki. Fetched server-side through the SSRF egress guard.",
    },
    {
      key: "email",
      type: "string",
      label: "Atlassian account email",
      required: true,
      description: "The account email paired with the API token for Basic authentication.",
    },
    {
      key: "space_key",
      type: "string",
      label: "Space key",
      required: true,
      description: "The key of the space to mirror (one collection per space), e.g. ENG.",
    },
    {
      key: "api_token",
      type: "string",
      secret: true,
      label: "API token",
      required: true,
      description:
        "An Atlassian API token (id.atlassian.com → Security → API tokens). Stored encrypted; never returned.",
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

/**
 * The GitBook Cloud connector Knowledge Base catalog row (#4393, ADR-0030). A
 * form install that mirrors ONE GitBook space into a review-gated collection;
 * the Scheduler dispatches the registered GitBook connector on a cadence
 * (incremental + reconciliation) and every synced page lands `draft`.
 *
 * `api_token` is `secret: true` but is NOT stored in `workspace_plugins.config`
 * — the install handler routes it to `knowledge_sync_credentials` (encrypted).
 * The GitBook API host is a fixed vendor constant, so there is no base-URL field
 * (unlike Confluence); every request still goes through the SSRF egress guard at
 * fetch time. The id/slug are the config SSOT (`GITBOOK_CATALOG_ID` /
 * `GITBOOK_SLUG`).
 */
export const BUILTIN_GITBOOK_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: GITBOOK_CATALOG_ID,
  slug: GITBOOK_SLUG,
  name: "Knowledge Base (GitBook)",
  description:
    "Mirror a GitBook Cloud space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "space_id",
      type: "string",
      label: "GitBook space id",
      required: true,
      description:
        "The id of the space to mirror (one collection per space). Copy it from your space URL: app.gitbook.com/o/…/s/<space-id>/… — you can paste the whole URL.",
    },
    {
      key: "api_token",
      type: "string",
      secret: true,
      label: "API token",
      required: true,
      description:
        "A GitBook API token (app.gitbook.com → Settings → Developer → API tokens). Stored encrypted; never returned.",
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

/** Every built-in Knowledge Base catalog row, in seed order. */
export const BUILTIN_KNOWLEDGE_CATALOG_ROWS: ReadonlyArray<BuiltinKnowledgeCatalogRow> = [
  BUILTIN_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_BUNDLE_SYNC_CATALOG_ROW,
  BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_CONFLUENCE_CATALOG_ROW,
  BUILTIN_GITBOOK_CATALOG_ROW,
];

/**
 * Narrow shape of the DB client the seeder needs. Mirrors
 * `BuiltinDatasourceCatalogSeedDb` so a single mock pool serves both
 * seeders in tests.
 */
export interface BuiltinKnowledgeCatalogSeedDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface BuiltinKnowledgeCatalogSeedResult {
  /** True when any `ON CONFLICT DO NOTHING` ran an insert (a row didn't exist). */
  readonly inserted: boolean;
  /** The slugs actually inserted this pass (empty on a fully-populated catalog). */
  readonly insertedSlugs: ReadonlyArray<string>;
}

/**
 * Idempotently seed every row in `BUILTIN_KNOWLEDGE_CATALOG_ROWS`.
 *
 * Column order matches the built-in Datasource seed's VALUES block so the two
 * seeds stay structurally recognizable; `type` and `pillar` differ (`context` /
 * `knowledge`). `RETURNING slug` reports whether each row was inserted vs
 * preserved. Rows seed sequentially: a pre-existing row never blocks the next,
 * but a hard failure aborts the pass and propagates (the boot wrapper logs and continues booting).
 */
export async function seedBuiltinKnowledgeCatalog(
  db: BuiltinKnowledgeCatalogSeedDb,
): Promise<BuiltinKnowledgeCatalogSeedResult> {
  // Operator-curated-only gate (#4174/#4099): these rows ship inside Atlas.
  assertOperatorCatalogWrite("builtin-knowledge-seed");

  const insertedSlugs: string[] = [];
  for (const row of BUILTIN_KNOWLEDGE_CATALOG_ROWS) {
    const { rows } = await db.query<{ slug: string }>(
      `INSERT INTO plugin_catalog
         (id, name, slug, description, type, install_model, pillar,
          implementation_status, auto_install, min_plan, enabled, saas_eligible,
          config_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'context', $5, 'knowledge', 'available', $6,
               'starter', true, $7, $8::jsonb, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING slug`,
      [
        row.id,
        row.name,
        row.slug,
        row.description,
        row.installModel,
        row.autoInstall,
        row.saasEligible,
        JSON.stringify(row.configSchema),
      ],
    );
    if (rows.length > 0) insertedSlugs.push(row.slug);
  }

  log.info(
    { insertedSlugs, slugs: BUILTIN_KNOWLEDGE_CATALOG_ROWS.map((r) => r.slug) },
    "Built-in Knowledge Base catalog seed complete",
  );
  return { inserted: insertedSlugs.length > 0, insertedSlugs };
}

/**
 * Discriminated outcome of {@link runBuiltinKnowledgeCatalogSeedBoot}.
 * Mirrors the Datasource seed's boot result so the Effect Layer can surface
 * skip vs error to health consumers without conflating them.
 */
export type BuiltinKnowledgeCatalogSeedBootResult =
  | { readonly kind: "skipped"; readonly reason: "no-internal-db" }
  | { readonly kind: "seeded"; readonly inserted: boolean }
  | { readonly kind: "error"; readonly message: string };

/**
 * Boot-pass wrapper. Log-and-continue posture (mirrors
 * `runBuiltinDatasourceCatalogSeedBoot`): a seed failure leaves the
 * pre-existing row authoritative rather than crashing the API.
 */
export async function runBuiltinKnowledgeCatalogSeedBoot(): Promise<BuiltinKnowledgeCatalogSeedBootResult> {
  const { hasInternalDB, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );

  if (!hasInternalDB()) {
    log.info(
      "Built-in Knowledge Base catalog seed: no internal DB configured, skipping",
    );
    return { kind: "skipped", reason: "no-internal-db" };
  }

  const pool = getInternalDB();
  const db: BuiltinKnowledgeCatalogSeedDb = {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
  };

  try {
    const result = await seedBuiltinKnowledgeCatalog(db);
    return { kind: "seeded", inserted: result.inserted };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized },
      "Built-in Knowledge Base catalog seed failed — rows from a prior boot remain authoritative",
    );
    return { kind: "error", message: normalized.message };
  }
}
