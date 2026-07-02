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

/** Per-status document counts for one collection. */
export interface KnowledgeDocumentCounts {
  readonly draft: number;
  readonly published: number;
  readonly archived: number;
}

/**
 * One collection in the workspace's Knowledge Base, as returned by
 * `GET /api/v1/admin/knowledge`. Archived collections are excluded.
 */
export interface KnowledgeCollection {
  /** Collection slug = `workspace_plugins.install_id`. */
  readonly slug: string;
  /** Optional human description from the install config. */
  readonly description: string | null;
  /** ISO-8601 install timestamp, or null if unavailable. */
  readonly installedAt: string | null;
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
  readonly format: "tar" | "tar.gz" | "zip";
  readonly documents: KnowledgeIngestDocumentCounts;
  readonly linksWritten: number;
  readonly published: boolean;
  readonly rejected: ReadonlyArray<KnowledgeRejectedFile>;
}

/** `DELETE /api/v1/admin/knowledge/{slug}` response. */
export interface KnowledgeUninstallResponse {
  readonly archived: boolean;
  readonly collection: string;
  readonly archivedDocuments: number;
}
