/**
 * Boot-time idempotent seed pass for the built-in Knowledge Base catalog rows
 * — the upload/bundle-sync arms, the vendor connectors, and the Company Atlas
 * ingest sources. `BUILTIN_KNOWLEDGE_CATALOG_ROWS` is the authoritative list
 * (fourteen today); adding a connector is one append there.
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
 * Idempotency: `ON CONFLICT (id) DO NOTHING` — the target is qualified on the
 * PRIMARY KEY, so re-running on a populated catalog is a no-op. It is
 * deliberately NOT unqualified; the slug-collision note below is the whole
 * reason. A seed-time failure logs at error and the API keeps booting — the
 * rows from a prior boot answer admin-UI reads.
 *
 * ⚠️ INSERT-ONLY BY DESIGN, and that posture is load-bearing (#5082). The
 * constants below describe the shape a row is BORN with — they are NOT a
 * declarative desired state the seeder reconciles towards. `ON CONFLICT DO
 * NOTHING` never touches a row that already exists, so editing a `name` or
 * `description` here changes nothing in any region that has already booted
 * once: new installs get the new copy, every existing region keeps the old,
 * and nothing reports the divergence. That is deliberate — it is also what
 * keeps an operator's edit through the catalog CRUD path
 * (`lib/integrations/catalog-crud.ts`) from being reverted on the next boot.
 *
 * The consequence is a rule, not a caveat: **changing a field on an EXISTING
 * built-in row takes a migration.** ADR-0038's rename of the two Company Atlas
 * ingest rows is migration `0201_brain_catalog_rows_company_atlas.sql`, and
 * `__tests__/seed-builtin-knowledge-catalog.test.ts` pins these constants to
 * the literals that migration writes, so the next rename cannot update one and
 * miss the other. The same file carries a COPY LOCK over every row in this
 * file: `name`, `description`, `saasEligible`, `autoInstall`. The rule was
 * never specific to those two rows, only the defect was. Adding a NEW row is
 * still one append here and nothing else.
 *
 * ⚠️ `config_schema` is stored under the same conflict target and is
 * customer-read (it renders as install-form labels and helper text), so it
 * carries the identical constraint. The two Company Atlas rows' helper text is
 * migration `0203_brain_catalog_config_help_company_atlas.sql` (#5240) — a
 * guarded rewrite of one string INSIDE the JSONB array, matched on the
 * known-old value so an operator-edited schema is never clobbered — and the
 * same test file pins these constants to what it writes.
 *
 * ⚠️ A SLUG COLLISION UNDER A FOREIGN ID IS LOUD, NOT SILENT (#5239). Because
 * the conflict target names `(id)`, `DO NOTHING` covers the primary key only.
 * A row already holding one of these slugs under a DIFFERENT id therefore
 * raises `23505` rather than no-op'ing. The loop recovers from a `23505` that
 * names the slug index (or names no constraint at all), logs a `warn`, records
 * the slug in `blockedSlugs`, and carries on. A `23505` naming any OTHER
 * constraint propagates, as does every other error — so a real outage is never
 * demoted to a warning, and a violation this recovery does not model is never
 * filed as a blocked slug.
 *
 * Until #5239 the target was unqualified and the same collision was swallowed:
 * `insertedSlugs` stayed empty and the pass reported `{ kind: "seeded" }` with
 * every slug listed, for a row that does not exist under its canonical id and
 * never will — indistinguishable from "the row was already there". It also
 * compounds: any migration keyed on the canonical id (0201 and 0203 among them)
 * then correctly finds nothing, and the admin UI never lists the row.
 *
 * The window is narrow — `slug` is settable only at create, per
 * `lib/integrations/catalog-crud.ts`, so it needs an operator-created row that
 * predates the built-in ever being seeded — but it is production-reachable.
 *
 * `blockedSlugs` is carried on the result and threaded through the boot Layer's
 * `BuiltinKnowledgeCatalogSeedShape`. **Nothing serves that shape over HTTP
 * today** — the `BuiltinKnowledgeCatalogSeed` Tag is boot ordering plus logging,
 * with no `/health` reader — so the operator-visible signal is the `log.warn`
 * below, and the field is what a caller (or a test) can assert on. Threading it
 * anyway is deliberate: the alternative is a boot Layer whose only description
 * of an incomplete catalog is the word "seeded".
 */

import { createLogger } from "@atlas/api/lib/logger";
import { CONFLUENCE_CATALOG_ID, CONFLUENCE_SLUG } from "@atlas/api/lib/knowledge/confluence/config";
import {
  CONFLUENCE_DC_CATALOG_ID,
  CONFLUENCE_DC_SLUG,
} from "@atlas/api/lib/knowledge/confluence/config-datacenter";
import {
  NOTION_KNOWLEDGE_CATALOG_ID,
  NOTION_KNOWLEDGE_SLUG,
} from "@atlas/api/lib/knowledge/notion/connector";
import { GITBOOK_CATALOG_ID, GITBOOK_SLUG } from "@atlas/api/lib/knowledge/gitbook/config";
import { ZENDESK_CATALOG_ID, ZENDESK_SLUG } from "@atlas/api/lib/knowledge/zendesk/config";
import { INTERCOM_CATALOG_ID, INTERCOM_SLUG } from "@atlas/api/lib/knowledge/intercom/config";
import {
  SALESFORCE_KNOWLEDGE_CATALOG_ID,
  SALESFORCE_KNOWLEDGE_SLUG,
} from "@atlas/api/lib/knowledge/salesforce/config";
import { FRONT_CATALOG_ID, FRONT_SLUG } from "@atlas/api/lib/knowledge/front/config";
import { HELPSCOUT_CATALOG_ID, HELPSCOUT_SLUG } from "@atlas/api/lib/knowledge/helpscout/config";
import { FRESHDESK_CATALOG_ID, FRESHDESK_SLUG } from "@atlas/api/lib/knowledge/freshdesk/config";
import {
} from "@atlas/api/lib/brain/ingest/slack/config";
import {
  ZOOM_TRANSCRIPTS_CATALOG_ID,
  ZOOM_TRANSCRIPTS_SLUG,
} from "@atlas/api/lib/brain/ingest/zoom/config";
import {
  OUTLOOK_MAIL_CATALOG_ID,
  OUTLOOK_MAIL_SLUG,
} from "@atlas/api/lib/brain/ingest/outlook/config";
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
 * The Confluence Data Center / Server connector Knowledge Base catalog row
 * (#4394, PRD #4375). The self-managed sibling of the Cloud row: a form install
 * that mirrors ONE Confluence Server/DC space into a review-gated collection;
 * the Scheduler dispatches the registered Confluence DC connector on a cadence
 * (incremental + reconciliation) and every synced page lands `draft`.
 *
 * `api_token` (a Personal Access Token) is `secret: true` but is NOT stored in
 * `workspace_plugins.config` — the install handler routes it to
 * `knowledge_sync_credentials` (encrypted). The base URL is customer-supplied,
 * so every fetch goes through the SSRF egress guard. There is no email field
 * (unlike Cloud): a Server/DC PAT is a Bearer credential with no paired
 * username. The id/slug are the config SSOT (`CONFLUENCE_DC_CATALOG_ID` /
 * `CONFLUENCE_DC_SLUG`).
 */
export const BUILTIN_CONFLUENCE_DC_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: CONFLUENCE_DC_CATALOG_ID,
  slug: CONFLUENCE_DC_SLUG,
  name: "Knowledge Base (Confluence Data Center)",
  description:
    "Mirror a self-managed Confluence Data Center/Server space into a review-gated knowledge collection; Atlas syncs pages on a schedule (incremental + reconciliation) and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "base_url",
      type: "string",
      label: "Confluence base URL",
      required: true,
      description:
        "Your self-managed Confluence base URL, e.g. https://confluence.your-company.com. Fetched server-side through the SSRF egress guard.",
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
      label: "Personal Access Token",
      required: true,
      description:
        "A Confluence Server/DC Personal Access Token (Profile → Personal Access Tokens). Stored encrypted; never returned.",
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

/**
 * The Zendesk Guide connector Knowledge Base catalog row (#4396, PRD #4395 —
 * the support tier's anchor slice). A form install that enumerates the
 * account's help-center-enabled BRANDS and creates one review-gated collection
 * per brand; the Scheduler dispatches the registered Zendesk connector on a
 * cadence (native incremental feed + reconciliation) and every synced article
 * translation lands `draft`.
 *
 * `api_token` is `secret: true` but is NOT stored in `workspace_plugins.config`
 * — the install handler routes it to `knowledge_sync_credentials` (encrypted,
 * one row per brand collection). Hosts are composed from the validated
 * subdomain label (`*.zendesk.com`), so there is no free-form base-URL field;
 * every request still goes through the SSRF egress guard. The id/slug are the
 * config SSOT (`ZENDESK_CATALOG_ID` / `ZENDESK_SLUG`).
 */
export const BUILTIN_ZENDESK_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: ZENDESK_CATALOG_ID,
  slug: ZENDESK_SLUG,
  name: "Knowledge Base (Zendesk Guide)",
  description:
    "Mirror your Zendesk Guide help center into review-gated knowledge collections (one per brand); Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "subdomain",
      type: "string",
      label: "Zendesk subdomain",
      required: true,
      description:
        'The "acme" in acme.zendesk.com (you can paste the full URL). Brands are discovered automatically — one collection per help center.',
    },
    {
      key: "email",
      type: "string",
      label: "Zendesk account email",
      required: true,
      description: "The account email paired with the API token for token authentication.",
    },
    {
      key: "api_token",
      type: "string",
      secret: true,
      label: "API token",
      required: true,
      description:
        "A Zendesk API token (Admin Center → Apps and integrations → Zendesk API). Stored encrypted; never returned.",
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
 * The Salesforce Knowledge connector Knowledge Base catalog row (#4397,
 * PRD #4395). A form install that creates one review-gated collection per
 * article-object/channel scope; the Scheduler dispatches the registered
 * Salesforce connector on a cadence (indexed `SystemModstamp` incremental +
 * `queryMore` reconciliation) and every synced article version lands `draft`.
 *
 * The tier's one credential-model departure: NO secret field. The connector
 * reuses the workspace's existing Salesforce OAuth install
 * (`catalog:salesforce`, ADR-0014) via the lazy plugin loader — installing
 * this row registers no new connected app and writes no
 * `knowledge_sync_credentials` row. The id/slug are the config SSOT
 * (`SALESFORCE_KNOWLEDGE_CATALOG_ID` / `SALESFORCE_KNOWLEDGE_SLUG`).
 */
export const BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: SALESFORCE_KNOWLEDGE_CATALOG_ID,
  slug: SALESFORCE_KNOWLEDGE_SLUG,
  name: "Knowledge Base (Salesforce Knowledge)",
  description:
    "Mirror your Salesforce Knowledge articles into a review-gated knowledge collection using the workspace's existing Salesforce connection — no extra credentials; Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "channel",
      type: "string",
      label: "Channel scope",
      description:
        'Optional. Mirror only articles visible on one channel: "app" (internal), "pkb" (public knowledge base), "csp" (customer portal), or "prm" (partner portal). Leave empty for every published article.',
    },
    {
      key: "article_object",
      type: "string",
      label: "Article object",
      description:
        "Optional. The article-version object API name (default Knowledge__kav; Classic article types use <Type>__kav).",
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
 * The Intercom connector Knowledge Base catalog row (#4399, PRD #4395). A form
 * install that mirrors the workspace's Intercom Articles into a review-gated
 * collection; the Scheduler dispatches the registered Intercom connector on a
 * cadence and every synced article translation lands `draft`.
 *
 * Intercom has no server-side change feed and no multi-brand concept, so this is
 * the tier's simplest install: a single `access_token` plus an optional
 * description — one workspace maps to one collection, and the connector
 * reconciliation-diffs `updated_at` against the high-water mark each cycle.
 *
 * `access_token` is `secret: true` but is NOT stored in
 * `workspace_plugins.config` — the install handler routes it to
 * `knowledge_sync_credentials` (encrypted). The Intercom API host is a fixed
 * vendor constant, so there is no base-URL field; every request still goes
 * through the SSRF egress guard at fetch time. The id/slug are the config SSOT
 * (`INTERCOM_CATALOG_ID` / `INTERCOM_SLUG`).
 */
export const BUILTIN_INTERCOM_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: INTERCOM_CATALOG_ID,
  slug: INTERCOM_SLUG,
  name: "Knowledge Base (Intercom)",
  description:
    "Mirror your Intercom help center's published articles (all locales) into a review-gated knowledge collection; Atlas syncs on a schedule and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "access_token",
      type: "string",
      secret: true,
      label: "Access token",
      required: true,
      description:
        "An Intercom access token (Settings → Developers → your app → Authentication). Stored encrypted; never returned.",
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
 * The Front Knowledge Base connector catalog row (#4400, PRD #4395). A form
 * install that enumerates the company's knowledge bases and creates one
 * review-gated collection per KB; the Scheduler dispatches the registered Front
 * connector on a cadence (delta-less reconciliation-diff) and every synced
 * article locale lands `draft`.
 *
 * `api_token` (a Bearer token) is `secret: true` but is NOT stored in
 * `workspace_plugins.config` — the install handler routes it to
 * `knowledge_sync_credentials` (encrypted, one row per KB collection). Front's
 * Core API is a fixed vendor host, so there is no free-form base-URL field;
 * every request still goes through the SSRF egress guard. The id/slug are the
 * config SSOT (`FRONT_CATALOG_ID` / `FRONT_SLUG`).
 */
export const BUILTIN_FRONT_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: FRONT_CATALOG_ID,
  slug: FRONT_SLUG,
  name: "Knowledge Base (Front)",
  description:
    "Mirror your Front knowledge bases into review-gated knowledge collections (one per knowledge base); Atlas syncs published articles and their locale translations on a schedule and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "api_token",
      type: "string",
      secret: true,
      label: "API token",
      required: true,
      description:
        "A Front API token with the knowledge_bases:read scope (Front → Settings → Developers → API tokens). Knowledge bases are discovered automatically — one collection per KB. Stored encrypted; never returned.",
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
 * The Help Scout Docs connector Knowledge Base catalog row (#4398, PRD #4395 —
 * the simplest install in the support tier). A form install that enumerates the
 * account's Docs SITES and creates one review-gated collection per site; the
 * Scheduler dispatches the registered Help Scout connector on a cadence
 * (`sort=updatedAt` incremental + full reconciliation) and every synced article
 * lands `draft`.
 *
 * `api_key` is `secret: true` but is NOT stored in `workspace_plugins.config` —
 * the install handler routes it to `knowledge_sync_credentials` (encrypted, one
 * row per site collection). The Docs API host is a fixed vendor constant
 * (`docsapi.helpscout.net`), so there is no free-form base-URL field and no
 * subdomain field (sites are discovered automatically); every request still
 * goes through the SSRF egress guard. The id/slug are the config SSOT
 * (`HELPSCOUT_CATALOG_ID` / `HELPSCOUT_SLUG`).
 */
export const BUILTIN_HELPSCOUT_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: HELPSCOUT_CATALOG_ID,
  slug: HELPSCOUT_SLUG,
  name: "Knowledge Base (Help Scout Docs)",
  description:
    "Mirror your Help Scout Docs help center into review-gated knowledge collections (one per site); Atlas syncs published articles on a schedule (incremental + reconciliation) and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "api_key",
      type: "string",
      secret: true,
      label: "Docs API key",
      required: true,
      description:
        "A Help Scout Docs API key (Help Scout → Your Profile → Authentication → API Keys). Sites are discovered automatically — one collection per Docs site. Stored encrypted; never returned.",
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
 * The Freshdesk Solutions connector Knowledge Base catalog row (#4401,
 * PRD #4395). A form install that enumerates the account's Solutions categories
 * and creates one review-gated collection per category; the Scheduler
 * dispatches the registered Freshdesk connector on a cadence (delta-less
 * reconciliation-diff over a category folder→article tree-walk) and every
 * synced article translation lands `draft`.
 *
 * `api_key` is `secret: true` but is NOT stored in `workspace_plugins.config`
 * — the install handler routes it to `knowledge_sync_credentials` (encrypted,
 * one row per category collection). Hosts are composed from the validated
 * subdomain label (`*.freshdesk.com`), so there is no free-form base-URL field;
 * every request still goes through the SSRF egress guard. The id/slug are the
 * config SSOT (`FRESHDESK_CATALOG_ID` / `FRESHDESK_SLUG`).
 */
export const BUILTIN_FRESHDESK_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: FRESHDESK_CATALOG_ID,
  slug: FRESHDESK_SLUG,
  name: "Knowledge Base (Freshdesk Solutions)",
  description:
    "Mirror your Freshdesk Solutions help center into review-gated knowledge collections (one per category); Atlas syncs published articles and their language translations on a schedule and queues changes for review.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "subdomain",
      type: "string",
      label: "Freshdesk subdomain",
      required: true,
      description:
        'The "acme" in acme.freshdesk.com (you can paste the full URL). Solutions categories are discovered automatically — one collection per category.',
    },
    {
      key: "api_key",
      type: "string",
      secret: true,
      label: "API key",
      required: true,
      description:
        "Your Freshdesk API key (Profile settings → Your API Key). Stored encrypted; never returned.",
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      description: "Optional. A human description of this knowledge collection.",
    },
  ],
};

// ⚠️ NO `slack-history` ROW, and its absence is load-bearing (#5203, grill
// #5200 T3). Through #4770 this catalog row backed a SECOND Slack install —
// knowledge-pillar, credential-free, carrying a channel list and nothing else,
// because the connector reused the workspace's EXISTING Slack OAuth install for
// its token. Nothing about connecting Slack suggested it was load-bearing, so
// Atlas's own Slack ran live as a chat platform in three prod regions with
// extraction on while the brain ingested nothing for four days, every surface
// green.
//
// Migration 0198 DELETES `catalog:slack-history` and cascades its installs. This
// seeder is insert-only (`ON CONFLICT DO NOTHING`) over the list below, so
// re-adding a row here would silently re-create an installable card on the next
// boot — a card whose form handler no longer exists. Slack ingest is dispatched
// per WORKSPACE off the Chat Platform pillar install now; see
// `lib/brain/ingest/slack/connector.ts`.

/**
 * The Zoom transcript brain source (#4965) — ADR-0036 §T6's second connector
 * CLASS, and the first connector built on #4963's generalized seam.
 *
 * Like `slack-history` it CONSUMES one of the workspace's plan-capped
 * knowledge-collection slots, the price of reusing the collection spine
 * verbatim.
 *
 * UNLIKE `slack-history`, it carries a secret: a Zoom Server-to-Server OAuth
 * app's client id and secret, stored as one encrypted
 * `knowledge_sync_credentials` row (see `zoom-transcripts-form-handler.ts`).
 * The `accountId` is non-secret scope and stays in the install config. The
 * id/slug are the config SSOT (`ZOOM_TRANSCRIPTS_CATALOG_ID` /
 * `ZOOM_TRANSCRIPTS_SLUG`).
 */
export const BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: ZOOM_TRANSCRIPTS_CATALOG_ID,
  slug: ZOOM_TRANSCRIPTS_SLUG,
  name: "Company Atlas (Zoom transcripts)",
  description:
    "Read cloud-recording transcripts from Zoom into the Company Atlas as immutable, deduped episodes. Each meeting is granted only to the people who attended it — a meeting whose participant list cannot be read is skipped rather than ingested. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "accountId",
      type: "string",
      label: "Zoom account ID",
      required: true,
      description:
        "The Account ID from your Zoom Server-to-Server OAuth app's credentials page.",
    },
    {
      key: "clientId",
      type: "string",
      label: "Client ID",
      required: true,
      description: "The Client ID from the same Server-to-Server OAuth app.",
    },
    {
      key: "clientSecret",
      type: "string",
      // `secret: true` is what makes the admin form mask it and keeps it out of
      // the config echo — there is no `"password"` field TYPE in this schema,
      // and reaching for one would have rendered the secret in clear text.
      secret: true,
      label: "Client secret",
      required: true,
      description:
        "The Client Secret from the same app. Stored encrypted and never shown again. The app needs the cloud_recording:read:admin and meeting:read:admin scopes.",
    },
    {
      key: "hosts",
      type: "string",
      label: "Hosts",
      description:
        "Optional. Comma-separated Zoom host user IDs to narrow ingestion to. Leave blank to ingest every recorded meeting in the account.",
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      // Customer-read helper text, so ADR-0038's noun applies (#5240). Editing
      // it here renames nothing a region already holds — migration 0203 is the
      // half that reaches the three prod regions.
      description: "Optional. A human description of this Company Atlas source.",
    },
  ],
};

/**
 * The Outlook mail brain source (#4966) — ADR-0036 §T6's third connector CLASS,
 * and the first whose derived audience is knowingly a LOWER BOUND rather than an
 * exact set (`lib/brain/ingest/grant.ts`'s `deriveEmailRecipientGrant`).
 *
 * Like its two brain-source siblings it CONSUMES one of the workspace's
 * plan-capped knowledge-collection slots, the price of reusing the collection
 * spine verbatim.
 *
 * Its `mailboxes` field is REQUIRED — as `slack-history`'s `channels` is, and
 * as `zoom-transcripts`' `hosts` deliberately is NOT. That contrast is the point:
 * Zoom's blank field means "the whole account", and there is no such spelling
 * here, because Graph's application `Mail.Read` is tenant-wide with no narrower
 * form and an empty scope defaulting to "everything" would mean every mailbox in
 * the company. `lib/brain/ingest/outlook/config.ts` carries the argument. The
 * id/slug are the config SSOT (`OUTLOOK_MAIL_CATALOG_ID` / `OUTLOOK_MAIL_SLUG`).
 */
export const BUILTIN_OUTLOOK_MAIL_CATALOG_ROW: BuiltinKnowledgeCatalogRow = {
  id: OUTLOOK_MAIL_CATALOG_ID,
  slug: OUTLOOK_MAIL_SLUG,
  name: "Company Atlas (Outlook mail)",
  description:
    "Read selected Outlook mailboxes into the Company Atlas as immutable, deduped episodes. Each message is granted only to the people named in its From, To and Cc headers — blind-copied and forwarded-to recipients are deliberately NOT granted, so access is a lower bound on who saw the mail rather than a guess. Episodes are raw evidence; the claims drawn from them go through review before anything becomes an authoritative fact.",
  installModel: "form",
  autoInstall: false,
  saasEligible: true,
  configSchema: [
    {
      key: "tenantId",
      type: "string",
      label: "Directory (tenant) ID",
      required: true,
      description: "The Directory (tenant) ID from your Entra app registration's overview page.",
    },
    {
      key: "clientId",
      type: "string",
      label: "Application (client) ID",
      required: true,
      description: "The Application (client) ID from the same app registration.",
    },
    {
      key: "clientSecret",
      type: "string",
      // `secret: true` is what makes the admin form mask it and keeps it out of
      // the config echo — there is no `"password"` field TYPE in this schema,
      // and reaching for one would have rendered the secret in clear text.
      secret: true,
      label: "Client secret",
      required: true,
      description:
        "A client secret VALUE (not its ID) from the same app registration. Stored encrypted and never shown again. The app needs the Mail.Read and User.ReadBasic.All APPLICATION permissions with admin consent granted. Entra secrets expire — the sync fails loudly when one does.",
    },
    {
      key: "mailboxes",
      type: "string",
      label: "Mailboxes",
      required: true,
      description:
        "Comma-separated mailboxes to ingest, as email addresses or object IDs. Required: Microsoft's application-level mail permission covers the whole tenant, so Atlas asks you to name the mailboxes rather than inferring them. Narrow the app itself with an Exchange ApplicationAccessPolicy as well — Atlas cannot see whether you have.",
    },
    {
      key: "description",
      type: "string",
      label: "Description",
      // See the Zoom row's twin of this field: same string, same migration
      // (0203), same reason (#5240).
      description: "Optional. A human description of this Company Atlas source.",
    },
  ],
};

/** Every built-in Knowledge Base catalog row, in seed order. */
export const BUILTIN_KNOWLEDGE_CATALOG_ROWS: ReadonlyArray<BuiltinKnowledgeCatalogRow> = [
  BUILTIN_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_BUNDLE_SYNC_CATALOG_ROW,
  BUILTIN_NOTION_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_CONFLUENCE_CATALOG_ROW,
  BUILTIN_CONFLUENCE_DC_CATALOG_ROW,
  BUILTIN_GITBOOK_CATALOG_ROW,
  BUILTIN_ZENDESK_CATALOG_ROW,
  BUILTIN_SALESFORCE_KNOWLEDGE_CATALOG_ROW,
  BUILTIN_INTERCOM_CATALOG_ROW,
  BUILTIN_FRONT_CATALOG_ROW,
  BUILTIN_HELPSCOUT_CATALOG_ROW,
  BUILTIN_FRESHDESK_CATALOG_ROW,
  BUILTIN_ZOOM_TRANSCRIPTS_CATALOG_ROW,
  BUILTIN_OUTLOOK_MAIL_CATALOG_ROW,
];

/**
 * Narrow shape of the DB client the seeder needs. Mirrors
 * `BuiltinDatasourceCatalogSeedDb` so a single mock pool serves both
 * seeders in tests.
 */
export interface BuiltinKnowledgeCatalogSeedDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * ⚠️ TWO PRECONDITIONS ON THE SEAM ABOVE, both load-bearing for the #5239 recovery
 * below, and neither expressible in the type.
 *
 * 1. **It must autocommit.** The loop recovers from a per-row `23505` by
 *    logging and continuing. Inside an open transaction the first one poisons
 *    it, so every remaining INSERT fails `25P02` — not `23505`, so it rethrows
 *    and aborts the pass with `current transaction is aborted`, and the header's
 *    "carries on to the remaining rows" becomes false. The one production
 *    caller passes a `Pool` (see `runBuiltinKnowledgeCatalogSeedBoot`), where
 *    each statement is its own transaction.
 * 2. **It must surface pg errors FLAT.** `asUniqueViolation` reads a top-level
 *    `code`. `@effect/sql` wraps the driver error and moves it under `.cause`
 *    (`lib/integrations/install/routing-id-conflict.ts` walks the chain for
 *    exactly that reason), so an Effect-backed client would make every
 *    collision an unclassified throw — worse than before #5239, not better.
 */

export interface BuiltinKnowledgeCatalogSeedResult {
  /** True when any `ON CONFLICT (id) DO NOTHING` ran an insert (a row didn't exist). */
  readonly inserted: boolean;
  /** The slugs actually inserted this pass (empty on a fully-populated catalog). */
  readonly insertedSlugs: ReadonlyArray<string>;
  /**
   * The slugs a `23505` blocked — a DIFFERENT catalog id already holds the
   * slug, so the built-in row does not exist under its canonical id and this
   * pass could not create it (#5239). Distinct from "not inserted": a row
   * absent from BOTH lists already existed under its canonical id.
   *
   * ⚠️ "Already existed", NOT "already correct". The seed is insert-only and
   * never reads the row back, so its CONTENT is unobserved — an operator who
   * rewrote a built-in row through `catalog-crud.ts` lands in this same
   * bucket, which is the whole reason a field change takes a migration.
   */
  readonly blockedSlugs: ReadonlyArray<string>;
}

/** Postgres `unique_violation` (23505). */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * The one NAMED unique constraint this seeder's recovery models
 * (`0014_plugin_marketplace.sql`; mirrored in `db/schema.ts`).
 *
 * `plugin_catalog` has two unique constraints today — PK `id`, consumed by the
 * conflict target, and this one — so a 23505 reaching the catch is almost
 * certainly a slug collision. Naming it turns that inference into a condition
 * the code checks; an UNNAMED 23505 is still accepted, under the same hedge the
 * warning carries.
 */
const PG_SLUG_CONSTRAINT = "plugin_catalog_slug_key";

/**
 * The diagnostic fields of a `23505`, or `undefined` for any other rejection.
 *
 * `pg` rejects with a `DatabaseError` carrying untyped `code`/`constraint`/
 * `detail`, so this narrows rather than casts. It reads the CODE and not the
 * message: matching on prose would classify an unrelated failure whose message
 * happened to say "duplicate key" as a benign collision, and demoting a real
 * outage to a warning is the failure this catch exists to avoid.
 */
function asUniqueViolation(
  err: unknown,
): { readonly constraint?: string; readonly detail?: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  if (!("code" in err) || err.code !== PG_UNIQUE_VIOLATION) return undefined;
  const constraint = "constraint" in err && typeof err.constraint === "string" ? err.constraint : undefined;
  const detail = "detail" in err && typeof err.detail === "string" ? err.detail : undefined;
  return { constraint, detail };
}

/**
 * Idempotently seed every row in `BUILTIN_KNOWLEDGE_CATALOG_ROWS`.
 *
 * Column order matches the built-in Datasource seed's VALUES block so the two
 * seeds stay structurally recognizable; `type` and `pillar` differ (`context` /
 * `knowledge`). `RETURNING slug` reports whether each row was inserted vs
 * preserved. Rows seed sequentially: a pre-existing row never blocks the next,
 * a slug held under a foreign id is reported and skipped (#5239 — see the
 * header), and any other hard failure aborts the pass and propagates (the boot
 * wrapper logs and continues booting).
 *
 * ⚠️ The sibling built-in DATASOURCE seed (`seed-builtin-datasource-catalog.ts`)
 * still inserts with an unqualified `ON CONFLICT DO NOTHING` and so still has
 * the swallow described in this file's header. #5239 scoped itself to the
 * knowledge catalog; the class is the same one file over — and worse there,
 * because that seeder derives `preservedSlugs` as *all minus inserted* and its
 * docstring calls them rows that "already existed". A blocked row is therefore
 * positively REPORTED as present, where this seeder merely omitted it.
 */
export async function seedBuiltinKnowledgeCatalog(
  db: BuiltinKnowledgeCatalogSeedDb,
): Promise<BuiltinKnowledgeCatalogSeedResult> {
  // Operator-curated-only gate (#4174/#4099): these rows ship inside Atlas.
  assertOperatorCatalogWrite("builtin-knowledge-seed");

  const insertedSlugs: string[] = [];
  const blockedSlugs: string[] = [];
  for (const row of BUILTIN_KNOWLEDGE_CATALOG_ROWS) {
    let returned: { slug: string }[];
    try {
      const { rows } = await db.query<{ slug: string }>(
        `INSERT INTO plugin_catalog
           (id, name, slug, description, type, install_model, pillar,
            implementation_status, auto_install, min_plan, enabled, saas_eligible,
            config_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'context', $5, 'knowledge', 'available', $6,
                 'starter', true, $7, $8::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING
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
      returned = rows;
    } catch (err) {
      const collision = asUniqueViolation(err);
      // ⚠️ RETHROW COVERS TWO CASES, and the second one is the hedge made
      // structural. Anything that is not a unique violation is a real failure
      // (as before #5239) — and a 23505 that NAMES a constraint other than the
      // slug index is not the squatter this recovery models either. Recording
      // that as a blocked SLUG would file a future `UNIQUE (name)` violation
      // under "go rename the row holding this slug", which is a hedged message
      // next to unhedged data; the data loses. An unnamed 23505 still lands in
      // the recovery below, where the message's hedge covers it.
      const modelled =
        collision !== undefined &&
        (collision.constraint === undefined || collision.constraint === PG_SLUG_CONSTRAINT);
      if (!modelled) {
        // ⚠️ `blockedSlugs` DOES NOT SURVIVE THIS THROW. The boot wrapper turns
        // it into `{ kind: "error" }` and the Layer reports `blockedSlugs: []`,
        // so a pass that blocked row 6 and then hit a dead pool on row 9 would
        // otherwise report nothing blocked at all — the same "not inserted"
        // overloading #5239 exists to remove, one arm over. Emit the partial
        // list here or it is lost.
        if (blockedSlugs.length > 0) {
          log.warn(
            { blockedSlugs, insertedSlugs, abortingAt: row.id },
            "Built-in Knowledge Base catalog seed ABORTING with rows already blocked — this list is PARTIAL (the pass stopped early) and is NOT carried on the boot result, which will report an error with no blocked slugs",
          );
        }
        throw err;
      }
      blockedSlugs.push(row.slug);
      log.warn(
        {
          id: row.id,
          slug: row.slug,
          constraint: collision.constraint,
          detail: collision.detail,
          // ⚠️ The raw message, because `constraint` and `detail` are both
          // OPTIONAL — a driver that populates neither would otherwise leave
          // the operator a warning with no evidence of WHAT collided, and the
          // sentence below would be the only (inferred) diagnosis on offer.
          // Safe to log: every unique value on `plugin_catalog` is a slug or a
          // catalog id, neither of which is a secret.
          err: err instanceof Error ? err.message : String(err),
        },
        // ⚠️ HEDGED IN THE DIAGNOSIS *AND* IN THE REMEDY, because an earlier
        // draft hedged only the first. `plugin_catalog` has exactly two unique
        // constraints today — PK `id` (consumed by the conflict target) and
        // UNIQUE `slug` — so a 23505 arriving here is almost certainly a slug
        // collision. That is an inference from the current schema, not
        // something this catch verified. Admitting it and then telling the
        // operator to go look the row up BY SLUG re-asserts the same inference
        // as an instruction: on the branch the hedge exists for, that query
        // returns nothing and the warning reads as wrong. So the lookup is
        // conditioned on what `constraint` actually says.
        "Built-in Knowledge Base catalog row NOT seeded — a unique violation means another catalog row already holds one of this row's unique values under a different id, so the row does not exist under its canonical id: /admin/knowledge will not list it, and every migration keyed on that id will correctly find nothing. WHICH value collided is in `constraint`/`detail`, or in `err` when the driver omits them. If `constraint` is `plugin_catalog_slug_key` (the only non-primary-key unique index on this table today), find the holder with `SELECT id, name FROM plugin_catalog WHERE slug = '<slug>'`; if it names anything else, look up the column that constraint covers instead. Then rename or remove that row.",
      );
      continue;
    }
    if (returned.length > 0) insertedSlugs.push(row.slug);
  }

  const summary = {
    insertedSlugs,
    blockedSlugs,
    slugs: BUILTIN_KNOWLEDGE_CATALOG_ROWS.map((r) => r.slug),
  };
  if (blockedSlugs.length > 0) {
    // Not `info`: the pass finished, but the catalog is missing rows it was
    // asked to seed. Reporting that as completion is #5239's defect.
    log.warn(
      summary,
      "Built-in Knowledge Base catalog seed finished with BLOCKED rows — see the per-row warnings above",
    );
  } else {
    log.info(summary, "Built-in Knowledge Base catalog seed complete");
  }
  return { inserted: insertedSlugs.length > 0, insertedSlugs, blockedSlugs };
}

/**
 * Discriminated outcome of {@link runBuiltinKnowledgeCatalogSeedBoot}.
 * Mirrors the Datasource seed's boot result so the Effect Layer can surface
 * skip vs error to health consumers without conflating them.
 */
export type BuiltinKnowledgeCatalogSeedBootResult =
  | { readonly kind: "skipped"; readonly reason: "no-internal-db" }
  | {
      readonly kind: "seeded";
      readonly inserted: boolean;
      /**
       * Rows a foreign-id slug collision blocked (#5239). `seeded` with a
       * non-empty `blockedSlugs` is a real state — the pass ran, and the
       * catalog is missing rows it was asked to seed — so `kind` alone no
       * longer partitions the outcomes; this field does.
       *
       * Same name as on `BuiltinKnowledgeCatalogSeedResult` deliberately: one
       * concept either side of a call boundary.
       */
      readonly blockedSlugs: ReadonlyArray<string>;
    }
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
    return { kind: "seeded", inserted: result.inserted, blockedSlugs: result.blockedSlugs };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized },
      "Built-in Knowledge Base catalog seed failed — rows from a prior boot remain authoritative",
    );
    return { kind: "error", message: normalized.message };
  }
}
