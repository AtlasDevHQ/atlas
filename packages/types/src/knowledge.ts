/**
 * Wire types for the Knowledge Base admin surface (`/admin/knowledge`, #4209,
 * ADR-0028).
 *
 * A *collection* is a `pillar='knowledge'` `workspace_plugins` install whose
 * `install_id` is the slug; *documents* are hosted-OKF markdown files that
 * ingest into it as content-mode drafts. Returned by the
 * `/api/v1/admin/knowledge` routes and consumed by the admin UI (a pure HTTP
 * client — it never imports `@atlas/api`).
 */

/** Supported OKF bundle archive formats — the one place this union is named. */
export type KnowledgeBundleFormat = "tar" | "tar.gz" | "zip";

/** Per-status document counts for one collection. */
export interface KnowledgeDocumentCounts {
  readonly draft: number;
  readonly published: number;
  readonly archived: number;
}

/**
 * How a collection's content arrives:
 *   - `upload` — the `okf-upload` catalog row (explicit admin bundle uploads);
 *   - `bundle-sync` — the #4211 catalog row (a scheduled pull of a configured
 *     bundle endpoint);
 *   - `notion` — the #4378 Knowledge Sync Connector (a scheduled pull of a
 *     Notion workspace via an internal-integration token).
 *   - `confluence` — the #4377 Knowledge Sync Connector (a scheduled pull of a
 *     Confluence Cloud space via an API token).
 *   - `confluence-datacenter` — the #4394 Knowledge Sync Connector (a scheduled
 *     pull of a self-managed Confluence Data Center/Server space via a Personal
 *     Access Token; REST v1 instead of Cloud's v2).
 *   - `zendesk` — the #4396 Knowledge Sync Connector (a scheduled pull of one
 *     Zendesk Guide brand's help center via an API token; one collection per
 *     brand, one document per published article translation).
 *   - `salesforce-knowledge` — the #4397 Knowledge Sync Connector (a scheduled
 *     SOQL pull of published Salesforce Knowledge article versions over the
 *     workspace's EXISTING Salesforce OAuth install — no credential of its
 *     own; one document per published article-version language).
 *   - `intercom` — the #4399 Knowledge Sync Connector (a scheduled full-walk
 *     pull of the workspace's Intercom Articles via an access token; one
 *     collection per workspace, one document per published article locale.
 *     Intercom has no server-side change feed, so the connector
 *     reconciliation-diffs `updated_at` against the high-water mark).
 *   - `front` — the #4400 Knowledge Sync Connector (a scheduled pull of Front
 *     knowledge bases via a Bearer token; one collection per KB, one document
 *     per published article locale; delta-less reconciliation-diff).
 *
 * Every value except `upload` is a "synced" collection: its content is owned by
 * an external source, it has last-sync bookkeeping, and it can be re-pulled with
 * "Sync now". Only `bundle-sync` additionally exposes an `endpointUrl` /
 * `authScheme`; connector collections (`notion`, `confluence`,
 * `confluence-datacenter`, `gitbook`, `zendesk`, `salesforce-knowledge`,
 * `intercom`, `front`) carry neither (their credential is a token — or, for
 * `salesforce-knowledge`, the reused OAuth install — not an endpoint).
 */
export type KnowledgeCollectionSource =
  | "upload"
  | "bundle-sync"
  | "notion"
  | "confluence"
  | "confluence-datacenter"
  | "gitbook"
  | "zendesk"
  | "salesforce-knowledge"
  | "intercom"
  | "front";

/**
 * Bundle-endpoint auth schemes for `bundle-sync` collections — the one wire
 * home for this union (the server's `BUNDLE_SYNC_AUTH_SCHEMES` tuple and the
 * web mirrors derive from it). `none` = public endpoint, no credential row.
 */
export type KnowledgeSyncAuthScheme = "none" | "bearer" | "basic";

/**
 * Last-sync bookkeeping for a `bundle-sync` collection (#4211). Absent (null
 * on the collection) until the first sync attempt.
 */
export interface KnowledgeCollectionSyncStatus {
  /** ISO-8601 completion time of the last sync attempt (success or error). */
  readonly lastSyncAt: string;
  readonly status: "success" | "error";
  /** Actionable failure message when the last attempt errored. */
  readonly error: string | null;
}

/**
 * One collection in the workspace's Knowledge Base, as returned by
 * `GET /api/v1/admin/knowledge`. Archived collections are excluded.
 */
export interface KnowledgeCollection {
  /** Collection slug = `workspace_plugins.install_id`. */
  readonly slug: string;
  readonly source: KnowledgeCollectionSource;
  /** Optional human description from the install config. */
  readonly description: string | null;
  /** ISO-8601 install timestamp, or null if unavailable. */
  readonly installedAt: string | null;
  /** The configured bundle endpoint (non-secret) — `bundle-sync` only. */
  readonly endpointUrl: string | null;
  /**
   * Configured endpoint auth scheme (non-secret; the secret itself is never
   * echoed) — `bundle-sync` only, null for upload collections. Pre-fills the
   * edit-sync-settings dialog so a secret rotation doesn't require re-picking
   * the scheme. Optional so a response from an older API during a
   * deploy-overlap window still parses.
   */
  readonly authScheme?: KnowledgeSyncAuthScheme | null;
  /** Last-sync bookkeeping — `bundle-sync` only, null before the first sync. */
  readonly sync: KnowledgeCollectionSyncStatus | null;
  readonly documents: KnowledgeDocumentCounts;
}

/** `GET /api/v1/admin/knowledge` response. */
export interface KnowledgeCollectionListResponse {
  readonly collections: ReadonlyArray<KnowledgeCollection>;
}

/**
 * A document inside a collection, as returned by
 * `GET /api/v1/admin/knowledge/{slug}/documents`. Archived documents are
 * excluded, so `status` is only ever `draft` or `published`.
 */
export interface KnowledgeDocumentSummary {
  readonly id: string;
  /** Bundle path within the collection tree (unique per collection). */
  readonly path: string;
  readonly title: string | null;
  readonly description: string | null;
  /** OKF document `type` frontmatter, if present. */
  readonly type: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly status: "draft" | "published";
  /** ISO-8601 last-updated timestamp, or null. */
  readonly updatedAt: string | null;
}

/** `GET /api/v1/admin/knowledge/{slug}/documents` response. */
export interface KnowledgeDocumentListResponse {
  readonly collection: string;
  readonly documents: ReadonlyArray<KnowledgeDocumentSummary>;
}

/** A single file the ingest rejected, with a human-readable reason. */
export interface KnowledgeRejectedFile {
  readonly path: string;
  readonly reason: string;
}

/** Per-outcome document counts from an ingest run. */
export interface KnowledgeIngestDocumentCounts {
  readonly created: number;
  readonly updated: number;
  readonly demoted: number;
  readonly resurrected: number;
  readonly unchanged: number;
  readonly total: number;
}

/**
 * `POST /api/v1/admin/knowledge/{slug}/ingest` success response. `published`
 * reflects whether the request ran the atomic "upload & publish" promotion.
 */
export interface KnowledgeIngestSummary {
  readonly collection: string;
  readonly format: KnowledgeBundleFormat;
  readonly documents: KnowledgeIngestDocumentCounts;
  readonly linksWritten: number;
  readonly published: boolean;
  readonly rejected: ReadonlyArray<KnowledgeRejectedFile>;
  /**
   * Non-markdown / asset files skipped by design (only `.md` ingests).
   * Reserved OKF navigation files (`index.md` / `log.md`) are also excluded
   * from ingest but are NOT counted here.
   */
  readonly skippedNonMarkdown: number;
}

/** `DELETE /api/v1/admin/knowledge/{slug}` response. */
export interface KnowledgeUninstallResponse {
  readonly archived: boolean;
  readonly collection: string;
  readonly archivedDocuments: number;
}

/**
 * `POST /api/v1/admin/knowledge/{slug}/sync` response (#4211) — the outcome of
 * one manual "Sync now" pull. A failed fetch/ingest is still a 200 with
 * `status: "error"` and an actionable message (the attempt itself completed
 * and was recorded on the collection's sync status); the ingest fields are
 * null in that case.
 */
export interface KnowledgeSyncRunResponse {
  readonly collection: string;
  readonly status: "success" | "error";
  /** ISO-8601 completion time of this attempt. */
  readonly syncedAt: string;
  readonly error: string | null;
  readonly format: KnowledgeBundleFormat | null;
  readonly documents: KnowledgeIngestDocumentCounts | null;
  /** Previously-ingested docs archived because their path left the bundle. */
  readonly archivedAbsent: number | null;
  readonly linksWritten: number | null;
  readonly rejected: ReadonlyArray<KnowledgeRejectedFile>;
}
