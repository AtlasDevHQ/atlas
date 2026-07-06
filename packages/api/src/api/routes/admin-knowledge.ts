/**
 * `admin-knowledge` — the Knowledge Base pillar's admin surface (#4207,
 * ADR-0028). Mounted under `/api/v1/admin/knowledge`; the one-surface-per-pillar
 * admin home for hosted OKF collections.
 *
 * A *collection* is a `pillar='knowledge'` `workspace_plugins` install
 * (`install_id` = slug). Installing one goes through the shared form-install
 * pipeline (`okf-upload` → `OkfUploadFormInstallHandler`; `bundle-sync` →
 * `BundleSyncFormInstallHandler`, #4211); this router owns the post-install
 * lifecycle:
 *
 *   - `GET  /`                          — list the workspace's collections + doc counts + sync status
 *   - `GET  /{collectionSlug}/documents` — list a collection's documents + status
 *   - `POST /{collectionSlug}/ingest`   — upload an OKF bundle into an UPLOAD collection
 *   - `POST /{collectionSlug}/sync`     — "Sync now" for a SYNCED (`bundle-sync`) collection (#4211)
 *   - `DELETE /{collectionSlug}`        — uninstall (archive docs, never delete)
 *
 * Ingest is the heart of the slice. The uploaded `.tar` / `.tar.gz` / `.zip`
 * bundle is UNTRUSTED third-party input: it is walked in memory (no fs), each
 * document parsed leniently (OKF is the at-rest normal form, not an ingest
 * requirement), and upserted by path at `status='draft'` — the review gate.
 * `?publish=true` ("upload & publish") runs the atomic content-mode promotion in
 * the SAME transaction (ADR-0028 §4); connector-style syncs (`bundle-sync`, and
 * future Notion/Confluence connectors) get no such option — every non-upload
 * collection is rejected from the ingest route outright, so synced content
 * always queues for review.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type {
  KnowledgeCollectionListResponse,
  KnowledgeDocumentListResponse,
  KnowledgeIngestSummary,
  KnowledgeSyncRunResponse,
  KnowledgeUninstallResponse,
} from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ingestBundle } from "@atlas/api/lib/knowledge/ingest-bundle";
import { uninstallCollection } from "@atlas/api/lib/knowledge/collection-lifecycle";
import { readBodyWithCap, BodyCapExceededError } from "@atlas/api/lib/knowledge/read-body-cap";
import { getIngestMaxBundleBytes } from "@atlas/api/lib/knowledge/ingest-limits";
import {
  buildCollectionDocumentsQuery,
  buildDocumentStatusCountsQuery,
  normTags,
  type AdminDocumentRow,
} from "@atlas/api/lib/knowledge/queries";
import { OKF_UPLOAD_CATALOG_ID } from "@atlas/api/lib/integrations/install/okf-upload-form-handler";
import {
  BUNDLE_SYNC_AUTH_SCHEMES,
  BUNDLE_SYNC_CATALOG_ID,
} from "@atlas/api/lib/integrations/install/bundle-sync-form-handler";
import { NOTION_KNOWLEDGE_CATALOG_ID } from "@atlas/api/lib/knowledge/notion/connector";
import { CONFLUENCE_CATALOG_ID } from "@atlas/api/lib/knowledge/confluence/config";
import { syncCollection } from "@atlas/api/lib/knowledge/sync";
import { getKnowledgeSyncConnector } from "@atlas/api/lib/knowledge/connectors";
import { syncConnectorCollection } from "@atlas/api/lib/knowledge/connector-sync";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin.knowledge");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load one collection install scoped to the workspace, or null. Matches ANY
 * knowledge-pillar catalog (`okf-upload` upload collections and `bundle-sync`
 * synced collections, #4211); `catalog_id` is returned so per-source routes
 * can gate — upload-ingest is upload-collections-only, "Sync now" is
 * synced-collections-only. The install-time cross-catalog slug guard makes a
 * duplicate (workspace, slug) across knowledge catalogs require a same-instant
 * race — it is a check-then-insert, not a DB constraint — so this LIMIT 1 read
 * assumes at most one row in practice.
 */
async function loadCollection(
  orgId: string,
  slug: string,
): Promise<{
  install_id: string;
  catalog_id: string;
  status: string;
  config: Record<string, unknown> | null;
} | null> {
  const rows = await internalQuery<{
    install_id: string;
    catalog_id: string;
    status: string;
    config: Record<string, unknown> | null;
  }>(
    `SELECT install_id, catalog_id, status, config
       FROM workspace_plugins
      WHERE workspace_id = $1 AND install_id = $2 AND pillar = 'knowledge'
      LIMIT 1`,
    [orgId, slug],
  );
  return rows[0] ?? null;
}

/** A synced-collection source discriminator + whether it is a connector. */
type KnowledgeSource = "upload" | "bundle-sync" | "notion" | "confluence" | "unknown";

/**
 * Map a knowledge catalog id to the wire `source` discriminator — matching
 * each KNOWN catalog explicitly so a future knowledge catalog can never default
 * into a privileged branch (`upload` is the source that inherits the
 * upload-&-publish ingest route, ADR-0028 §4). The gated routes reject
 * `"unknown"` outright; only the list rendering maps it to a wire label.
 */
function sourceOf(catalogId: string): KnowledgeSource {
  if (catalogId === OKF_UPLOAD_CATALOG_ID) return "upload";
  if (catalogId === BUNDLE_SYNC_CATALOG_ID) return "bundle-sync";
  if (catalogId === NOTION_KNOWLEDGE_CATALOG_ID) return "notion";
  if (catalogId === CONFLUENCE_CATALOG_ID) return "confluence";
  return "unknown";
}

/** True for a synced source (endpoint or connector) — has sync bookkeeping. */
function isSyncedSource(source: KnowledgeSource): boolean {
  return source === "bundle-sync" || source === "notion" || source === "confluence";
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RejectedFileSchema = z.object({ path: z.string(), reason: z.string() });

/** Last-sync bookkeeping surfaced per synced collection (#4211). */
const CollectionSyncStatusSchema = z.object({
  lastSyncAt: z.string(),
  status: z.enum(["success", "error"]),
  error: z.string().nullable(),
});

const CollectionListResponseSchema = z.object({
  collections: z.array(
    z.object({
      slug: z.string(),
      source: z.enum(["upload", "bundle-sync", "notion", "confluence"]),
      description: z.string().nullable(),
      installedAt: z.string().nullable(),
      endpointUrl: z.string().nullable(),
      authScheme: z.enum(["none", "bearer", "basic"]).nullable(),
      sync: CollectionSyncStatusSchema.nullable(),
      documents: z.object({
        draft: z.number().int().nonnegative(),
        published: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
      }),
    }),
  ),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Knowledge"],
  summary: "List knowledge collections",
  description:
    "List the workspace's Knowledge Base collections (excluding archived) with per-status document " +
    "counts. `source` distinguishes upload collections (`okf-upload`) from synced collections " +
    "(`bundle-sync`); synced collections also carry their non-secret `endpointUrl` and last-sync " +
    "bookkeeping (`sync` — null until the first sync attempt).",
  responses: {
    200: {
      description: "Collection list",
      content: {
        "application/json": {
          schema: CollectionListResponseSchema,
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const KnowledgeDocumentSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(["draft", "published"]),
  updatedAt: z.string().nullable(),
});

const DocumentListResponseSchema = z.object({
  collection: z.string(),
  documents: z.array(KnowledgeDocumentSchema),
});

const documentsRoute = createRoute({
  method: "get",
  path: "/{collectionSlug}/documents",
  tags: ["Admin — Knowledge"],
  summary: "List a knowledge collection's documents",
  description:
    "List the documents in one collection with their content-mode status (`draft` / `published`), " +
    "ordered by bundle path. Archived documents (from a prior uninstall) are excluded. Admins use " +
    "this to review what a bundle ingested and which documents are still pending publish.",
  request: {
    params: z.object({
      collectionSlug: z.string().min(1).openapi({ param: { name: "collectionSlug", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Document list",
      content: {
        "application/json": { schema: DocumentListResponseSchema },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Collection not found or no internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const IngestResponseSchema = z.object({
  collection: z.string(),
  format: z.enum(["tar", "tar.gz", "zip"]),
  documents: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    demoted: z.number().int().nonnegative(),
    resurrected: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  linksWritten: z.number().int().nonnegative(),
  published: z.boolean(),
  rejected: z.array(RejectedFileSchema),
  skippedNonMarkdown: z.number().int().nonnegative(),
});

const ingestRoute = createRoute({
  method: "post",
  path: "/{collectionSlug}/ingest",
  tags: ["Admin — Knowledge"],
  summary: "Ingest an OKF bundle into a collection",
  description:
    "Upload a `.tar`, `.tar.gz`, or `.zip` OKF bundle into a collection. Documents are parsed " +
    "leniently (plain markdown works — missing OKF frontmatter is stamped) and upserted by path at " +
    "`status='draft'`. Unparseable / oversized / unsafe-path files are rejected with per-file errors. " +
    "Pass `?publish=true` to atomically run the workspace publish in the same action — this promotes ALL pending drafts in the workspace (matching the atomic publish endpoint), not only the just-ingested documents.",
  request: {
    params: z.object({
      collectionSlug: z.string().min(1).openapi({ param: { name: "collectionSlug", in: "path" } }),
    }),
    query: z.object({
      publish: z
        .string()
        .optional()
        .openapi({ description: "Set to 'true' to run 'upload & publish' — atomically run the workspace publish (promotes all pending workspace drafts, per the atomic publish endpoint)." }),
    }),
    body: {
      content: {
        "application/octet-stream": {
          schema: z.any().openapi({ type: "string", format: "binary" }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Ingest summary",
      content: {
        "application/json": { schema: IngestResponseSchema },
      },
    },
    400: {
      description: "Bad bundle (empty, too large, unrecognized format, over doc cap, or all files rejected)",
      content: { "application/json": { schema: ErrorSchema.extend({ rejected: z.array(RejectedFileSchema).optional() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Collection not found or no internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** Wire shape of one sync attempt — mirrors `KnowledgeSyncOutcome` (#4211). */
const SyncRunResponseSchema = z.object({
  collection: z.string(),
  status: z.enum(["success", "error"]),
  syncedAt: z.string(),
  error: z.string().nullable(),
  format: z.enum(["tar", "tar.gz", "zip"]).nullable(),
  documents: z
    .object({
      created: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      demoted: z.number().int().nonnegative(),
      resurrected: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
  archivedAbsent: z.number().int().nonnegative().nullable(),
  linksWritten: z.number().int().nonnegative().nullable(),
  rejected: z.array(RejectedFileSchema),
});

const syncRoute = createRoute({
  method: "post",
  path: "/{collectionSlug}/sync",
  tags: ["Admin — Knowledge"],
  summary: "Sync a synced collection now",
  description:
    "Manually pull a synced collection's source (a bundle endpoint, or a connector like Notion) and " +
    "apply the diff immediately (the same run the scheduled sync performs — daily by default, " +
    "operator-tunable). Changed and new documents land as `draft` for review — synced content has no " +
    "publish shortcut; on a full reconciliation, paths absent from the fetched set are archived, " +
    "never hard-deleted. Returns the attempt's outcome; a failed fetch/ingest is reported as " +
    "`status: \"error\"` with an actionable message (also recorded on the collection's sync status).",
  request: {
    params: z.object({
      collectionSlug: z.string().min(1).openapi({ param: { name: "collectionSlug", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Sync attempt outcome (success or error — see `status`)",
      content: { "application/json": { schema: SyncRunResponseSchema } },
    },
    400: {
      description: "Not a synced collection (upload collections have no source to pull)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Collection not found or no internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const UninstallResponseSchema = z.object({
  archived: z.boolean(),
  collection: z.string(),
  archivedDocuments: z.number().int().nonnegative(),
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{collectionSlug}",
  tags: ["Admin — Knowledge"],
  summary: "Uninstall a knowledge collection",
  description:
    "Uninstall a collection: its documents are ARCHIVED (status='archived'), never hard-deleted, and the " +
    "collection install is archived. A later re-install does not by itself resurrect the archived " +
    "documents — but any ingest that sees an archived path again brings it back as a `draft` for " +
    "re-review: re-uploading a bundle (upload collections), or the next sync after re-installing a " +
    "bundle-sync collection (the endpoint is the source of truth for its tree).",
  request: {
    params: z.object({
      collectionSlug: z.string().min(1).openapi({ param: { name: "collectionSlug", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Collection uninstalled",
      content: {
        "application/json": { schema: UninstallResponseSchema },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Collection not found or no internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminKnowledge = createAdminRouter();
adminKnowledge.use(requireOrgContext());

adminKnowledge.openapi(listRoute, async (c) =>
  runHandler(c, "list knowledge collections", async () => {
    const { orgId } = c.get("orgContext");
    const countsQuery = buildDocumentStatusCountsQuery(orgId);
    const [installs, counts, syncStates] = await Promise.all([
      internalQuery<{
        install_id: string;
        catalog_id: string;
        config: Record<string, unknown> | null;
        installed_at: string | null;
      }>(
        `SELECT install_id,
                catalog_id,
                config,
                to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at
           FROM workspace_plugins
          WHERE workspace_id = $1 AND pillar = 'knowledge'
            AND status <> 'archived'
          ORDER BY installed_at ASC`,
        [orgId],
      ),
      internalQuery<{ collection_id: string; status: string; n: number }>(
        countsQuery.text,
        countsQuery.params,
      ),
      internalQuery<{ collection_id: string; last_sync_at: string; status: string; error: string | null }>(
        `SELECT collection_id,
                to_char(last_sync_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_sync_at,
                status,
                error
           FROM knowledge_sync_state
          WHERE workspace_id = $1`,
        [orgId],
      ),
    ]);

    const countsBySlug = new Map<string, { draft: number; published: number; archived: number }>();
    for (const row of counts) {
      const entry = countsBySlug.get(row.collection_id) ?? { draft: 0, published: 0, archived: 0 };
      if (row.status === "draft") entry.draft = row.n;
      else if (row.status === "published") entry.published = row.n;
      else if (row.status === "archived") entry.archived = row.n;
      countsBySlug.set(row.collection_id, entry);
    }

    const syncBySlug = new Map<
      string,
      { lastSyncAt: string; status: "success" | "error"; error: string | null }
    >();
    for (const row of syncStates) {
      syncBySlug.set(row.collection_id, {
        lastSyncAt: row.last_sync_at,
        // The table CHECK pins success|error; if something unexpected slips
        // through, fail toward "error" — never report a sync healthy on a
        // value we don't recognize.
        status: row.status === "success" ? ("success" as const) : ("error" as const),
        error: row.error,
      });
    }

    return c.json(
      {
        collections: installs.flatMap((r) => {
          const description = r.config?.description;
          const source = sourceOf(r.catalog_id);
          // An install from an unrecognized knowledge catalog (unreachable
          // today — only the four built-in catalogs, okf-upload / bundle-sync /
          // notion-knowledge / confluence, can create knowledge installs) has
          // no admin affordances: painting it as an "upload" collection would
          // offer actions its route gates reject. Skip it loudly instead of
          // mislabeling it.
          if (source === "unknown") {
            log.warn(
              { orgId, installId: r.install_id, catalogId: r.catalog_id },
              "Skipping knowledge install with unrecognized catalog from the admin list",
            );
            return [];
          }
          const endpointUrl = r.config?.endpoint_url;
          const rawAuthScheme = r.config?.auth_scheme;
          return [
            {
              slug: r.install_id,
              source,
              description: typeof description === "string" ? description : null,
              installedAt: r.installed_at,
              // Non-secret by construction — the auth secret lives only in
              // knowledge_sync_credentials, never in config.
              endpointUrl:
                source === "bundle-sync" && typeof endpointUrl === "string" ? endpointUrl : null,
              // The scheme (not the secret) pre-fills the edit-sync-settings
              // dialog. An unrecognized stored value renders as "none" — the
              // sync engine itself rejects it with an actionable error.
              authScheme:
                source === "bundle-sync"
                  ? typeof rawAuthScheme === "string" &&
                    (BUNDLE_SYNC_AUTH_SCHEMES as readonly string[]).includes(rawAuthScheme)
                    ? (rawAuthScheme as (typeof BUNDLE_SYNC_AUTH_SCHEMES)[number])
                    : ("none" as const)
                  : null,
              // Every synced source (endpoint or connector) carries last-sync
              // bookkeeping; only upload collections have none.
              sync: isSyncedSource(source) ? syncBySlug.get(r.install_id) ?? null : null,
              documents: countsBySlug.get(r.install_id) ?? { draft: 0, published: 0, archived: 0 },
            },
          ];
        }),
        // `satisfies` ties the route payload to the published wire type — a
        // schema/handler rename that drifts from `@useatlas/types` is a compile
        // error here instead of a runtime web Zod parse failure.
      } satisfies KnowledgeCollectionListResponse,
      200,
    );
  }),
);

adminKnowledge.openapi(documentsRoute, async (c) =>
  runHandler(c, "list knowledge documents", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { collectionSlug } = c.req.valid("param");

    const collection = await loadCollection(orgId, collectionSlug);
    if (!collection || collection.status === "archived") {
      return c.json(
        { error: "not_found", message: `No knowledge collection "${collectionSlug}".`, requestId },
        404,
      );
    }

    const docsQuery = buildCollectionDocumentsQuery(orgId, collectionSlug);
    const rows = await internalQuery<AdminDocumentRow>(docsQuery.text, docsQuery.params);

    return c.json(
      {
        collection: collectionSlug,
        documents: rows.map((r) => ({
          id: r.id,
          path: r.path,
          title: r.title,
          description: r.description,
          type: r.type,
          // `tags` is a jsonb array; keep only string members so a
          // malformed frontmatter array never breaks the wire contract.
          tags: normTags(r.tags),
          // The query's archived filter guarantees draft | published only.
          status: r.status === "published" ? ("published" as const) : ("draft" as const),
          updatedAt: r.updated_at,
        })),
      } satisfies KnowledgeDocumentListResponse,
      200,
    );
  }),
);

adminKnowledge.openapi(ingestRoute, async (c) =>
  runHandler(c, "ingest knowledge bundle", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { collectionSlug } = c.req.valid("param");
    const { publish } = c.req.valid("query");
    const shouldPublish = publish === "true";

    const collection = await loadCollection(orgId, collectionSlug);
    if (!collection || collection.status === "archived") {
      return c.json(
        { error: "not_found", message: `No knowledge collection "${collectionSlug}".`, requestId },
        404,
      );
    }
    // A synced collection's tree is owned by its endpoint — a manual upload
    // would be archived-as-absent on the next pull, and the ADR-0028 §4 rule
    // that connector-synced content never pairs with publish is enforced by
    // keeping everything except upload collections off this route entirely
    // (#4211). Fail-closed: an unrecognized knowledge catalog is rejected too,
    // never granted the privileged upload(-&-publish) path by default.
    if (sourceOf(collection.catalog_id) !== "upload") {
      return c.json(
        {
          error: "synced_collection",
          message: `"${collectionSlug}" is not an upload collection — its content comes from its integration. Use "Sync now" instead of uploading.`,
          requestId,
        },
        400,
      );
    }

    // Read the raw bundle bytes. Reject on the declared Content-Length BEFORE
    // reading the body, so an obviously-oversized upload fails immediately; the
    // client-supplied header is advisory, so the body is then STREAMED with a
    // cumulative cap (the same `readBodyWithCap` guard the sync fetch uses) — a
    // chunked or lying upload aborts the moment it crosses the limit instead of
    // fully materializing in memory first. The remaining caps (decompression
    // bomb, doc count/bytes) live inside `ingestBundle` (the shared seam).
    const maxBundleBytes = getIngestMaxBundleBytes();
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBundleBytes) {
      return c.json(
        {
          error: "bundle_too_large",
          message: `Bundle is ${declaredLength} bytes, over the ${maxBundleBytes}-byte limit.`,
          requestId,
        },
        400,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBodyWithCap(c.req.raw.body, maxBundleBytes, { requestId });
    } catch (err) {
      if (err instanceof BodyCapExceededError) {
        return c.json(
          {
            error: "bundle_too_large",
            message: `Bundle exceeds the ${maxBundleBytes}-byte limit — upload aborted.`,
            requestId,
          },
          400,
        );
      }
      throw err;
    }

    // The shared seam owns extract → parse → caps → transaction (+ the atomic
    // "upload & publish" promotion, ADR-0028 §4 — upload collections only, the
    // source gate above; and the uninstall × in-flight-ingest race guard) →
    // mirror invalidation. This route is the HTTP disposition adapter: every
    // failure kind maps to a 4xx.
    const outcome = await ingestBundle({
      workspaceId: orgId,
      collectionId: collectionSlug,
      source: "upload",
      bytes,
      publish: shouldPublish,
    });

    if (outcome.kind !== "ok") {
      switch (outcome.kind) {
        case "install_gone":
          // Uninstall × in-flight-upload race: the pre-check above saw a live
          // collection, an uninstall landed while the body streamed/parsed, and
          // the seam's in-transaction re-check aborted before any write. Same
          // disposition as the pre-check: the collection is gone.
          return c.json(
            { error: "not_found", message: `No knowledge collection "${collectionSlug}".`, requestId },
            404,
          );
        case "empty_bundle":
          return c.json(
            { error: "empty_bundle", message: "The uploaded bundle is empty.", requestId },
            400,
          );
        case "bundle_too_large":
          return c.json(
            {
              error: "bundle_too_large",
              message: `Bundle is ${outcome.bytes} bytes, over the ${outcome.maxBundleBytes}-byte limit.`,
              requestId,
            },
            400,
          );
        case "invalid_bundle":
          return c.json({ error: "invalid_bundle", message: outcome.message, requestId }, 400);
        case "too_many_documents":
          return c.json(
            {
              error: "too_many_documents",
              message: `Bundle has ${outcome.count} documents, over the ${outcome.maxDocs}-document limit.`,
              requestId,
            },
            400,
          );
        case "no_documents":
          return c.json(
            {
              error: "no_documents",
              message:
                outcome.rejected.length > 0
                  ? "No ingestable documents — every file was rejected. See `rejected` for per-file reasons."
                  : "No ingestable markdown documents found in the bundle.",
              requestId,
              rejected: [...outcome.rejected],
            },
            400,
          );
      }
    }

    const { report, rejected } = outcome;

    logAdminAction({
      actionType: ADMIN_ACTIONS.knowledge.ingest,
      targetType: "knowledge",
      targetId: collectionSlug,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: {
        collectionSlug,
        format: outcome.format,
        created: report.created,
        updated: report.updated,
        demoted: report.demoted,
        resurrected: report.resurrected,
        unchanged: report.unchanged,
        linksWritten: report.linksWritten,
        rejected: rejected.length,
        published: shouldPublish,
      },
    });

    log.info(
      { requestId, orgId, collectionSlug, format: outcome.format, ...report, published: shouldPublish, rejected: rejected.length },
      "Knowledge bundle ingested",
    );

    return c.json(
      {
        collection: collectionSlug,
        format: outcome.format,
        documents: {
          created: report.created,
          updated: report.updated,
          demoted: report.demoted,
          resurrected: report.resurrected,
          unchanged: report.unchanged,
          total: report.documents,
        },
        linksWritten: report.linksWritten,
        published: shouldPublish,
        rejected: [...rejected],
        skippedNonMarkdown: outcome.skippedNonMarkdown,
      } satisfies KnowledgeIngestSummary,
      200,
    );
  }),
);

adminKnowledge.openapi(syncRoute, async (c) =>
  runHandler(c, "sync knowledge collection", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { collectionSlug } = c.req.valid("param");

    const collection = await loadCollection(orgId, collectionSlug);
    if (!collection || collection.status === "archived") {
      return c.json(
        { error: "not_found", message: `No knowledge collection "${collectionSlug}".`, requestId },
        404,
      );
    }
    const source = sourceOf(collection.catalog_id);
    if (!isSyncedSource(source)) {
      return c.json(
        {
          error: "not_synced_collection",
          message: `"${collectionSlug}" is not a synced collection — only synced collections (endpoint or connector) have a source to pull.`,
          requestId,
        },
        400,
      );
    }

    // Both engines never throw: fetch hardening, ingest, archive-absent, and the
    // knowledge_sync_state upsert all happen inside. A failed attempt comes back
    // as `status: "error"` with a host-redacted, actionable message. Bundle-sync
    // pulls an endpoint; a connector (Notion) drives its registered vendor
    // client. Both map to the one sync-run wire shape — connectors carry no
    // bundle `format` / `linksWritten`, so those are null. Typed as the route
    // schema's inferred (mutable) shape; the module-level producer-drift guard
    // keeps it assignable to `KnowledgeSyncRunResponse`.
    let wire: z.infer<typeof SyncRunResponseSchema>;
    if (source === "bundle-sync") {
      const outcome = await syncCollection({
        workspaceId: orgId,
        collectionSlug,
        config: collection.config,
      });
      wire = {
        collection: outcome.collection,
        status: outcome.status,
        syncedAt: outcome.syncedAt,
        error: outcome.error,
        format: outcome.format,
        documents: outcome.documents,
        archivedAbsent: outcome.archivedAbsent,
        linksWritten: outcome.linksWritten,
        rejected: [...outcome.rejected],
      };
    } else {
      const connector = getKnowledgeSyncConnector(collection.catalog_id);
      if (connector === undefined) {
        // The source came from the same catalog-id map the connector registers
        // under, so this is only reachable if boot registration failed — a real
        // server misconfig, surfaced (not a silent success).
        log.error(
          { requestId, orgId, collectionSlug, catalogId: collection.catalog_id },
          "Synced collection has no registered connector — the boot registration did not run",
        );
        return c.json(
          {
            error: "connector_unavailable",
            message: `"${collectionSlug}" cannot sync — its connector is not registered on this server. Contact your operator.`,
            requestId,
          },
          500,
        );
      }
      const outcome = await syncConnectorCollection({
        connector,
        workspaceId: orgId,
        collectionSlug,
        config: collection.config,
      });
      wire = {
        collection: outcome.collection,
        status: outcome.status,
        syncedAt: outcome.syncedAt,
        error: outcome.error,
        format: null,
        documents: outcome.documents,
        archivedAbsent: outcome.archivedAbsent,
        linksWritten: null,
        rejected: [...outcome.rejected],
      };
    }

    logAdminAction({
      actionType: ADMIN_ACTIONS.knowledge.sync,
      targetType: "knowledge",
      targetId: collectionSlug,
      scope: "workspace",
      status: wire.status === "success" ? "success" : "failure",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: {
        collectionSlug,
        source,
        status: wire.status,
        error: wire.error,
        ...(wire.documents ?? {}),
        archivedAbsent: wire.archivedAbsent,
        rejected: wire.rejected.length,
      },
    });

    log.info(
      { requestId, orgId, collectionSlug, source, status: wire.status, error: wire.error },
      "Knowledge collection manual sync completed",
    );

    return c.json(wire satisfies KnowledgeSyncRunResponse, 200);
  }),
);

adminKnowledge.openapi(deleteRoute, async (c) =>
  runHandler(c, "uninstall knowledge collection", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const { collectionSlug } = c.req.valid("param");

    const collection = await loadCollection(orgId, collectionSlug);
    if (!collection) {
      return c.json(
        { error: "not_found", message: `No knowledge collection "${collectionSlug}".`, requestId },
        404,
      );
    }

    // The shared lifecycle seam owns the archive-on-uninstall transaction
    // (ADR-0028 §5 — documents archived, never hard-deleted; sync bookkeeping
    // + endpoint credential hard-deleted) and the mirror invalidation.
    const { archivedDocuments } = await uninstallCollection({
      workspaceId: orgId,
      collectionSlug,
    });

    logAdminAction({
      actionType: ADMIN_ACTIONS.knowledge.uninstall,
      targetType: "knowledge",
      targetId: collectionSlug,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { collectionSlug, archivedDocuments },
    });

    log.info({ requestId, orgId, collectionSlug, archivedDocuments }, "Knowledge collection uninstalled (archived)");

    return c.json(
      { archived: true, collection: collectionSlug, archivedDocuments } satisfies KnowledgeUninstallResponse,
      200,
    );
  }),
);

// ---------------------------------------------------------------------------
// Producer↔wire drift guards (#81 arch review, inverted-SSOT fix). The web
// mirrors in `admin-schemas.ts` are drift-checked against `@useatlas/types` —
// but the PRODUCER (these hono-`z` response schemas) previously had no tie to
// the wire types at all, so the types could silently lie about what the server
// returns. Each check asserts the schema's inferred output stays assignable to
// its canonical wire interface; a dropped/renamed field fails to type-check.
// ---------------------------------------------------------------------------
type _Expect<T extends true> = T;
export type _CollectionListProducerDrift = _Expect<
  z.infer<typeof CollectionListResponseSchema> extends KnowledgeCollectionListResponse
    ? true
    : false
>;
export type _DocumentListProducerDrift = _Expect<
  z.infer<typeof DocumentListResponseSchema> extends KnowledgeDocumentListResponse ? true : false
>;
export type _IngestProducerDrift = _Expect<
  z.infer<typeof IngestResponseSchema> extends KnowledgeIngestSummary ? true : false
>;
export type _SyncRunProducerDrift = _Expect<
  z.infer<typeof SyncRunResponseSchema> extends KnowledgeSyncRunResponse ? true : false
>;
export type _UninstallProducerDrift = _Expect<
  z.infer<typeof UninstallResponseSchema> extends KnowledgeUninstallResponse ? true : false
>;

export { adminKnowledge };
