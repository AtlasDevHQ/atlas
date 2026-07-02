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
import type { PoolClient } from "pg";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  getInternalDB,
  internalQuery,
  type InternalPoolClient,
} from "@atlas/api/lib/db/internal";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { Effect } from "effect";
import { extractBundle, BundleFormatError } from "@atlas/api/lib/knowledge/bundle-archive";
import { parseLenientBundle } from "@atlas/api/lib/knowledge/parse-lenient";
import { readBodyWithCap, BodyCapExceededError } from "@atlas/api/lib/knowledge/read-body-cap";
import { ingestBundleIntoCollection } from "@atlas/api/lib/knowledge/ingest";
import type {
  KnowledgeCollectionListResponse,
  KnowledgeDocumentListResponse,
  KnowledgeIngestSummary,
  KnowledgeSyncRunResponse,
  KnowledgeUninstallResponse,
} from "@useatlas/types";
import {
  getIngestMaxDocs,
  getIngestMaxDocBytes,
  getIngestMaxBundleBytes,
} from "@atlas/api/lib/knowledge/ingest-limits";
import { OKF_UPLOAD_CATALOG_ID } from "@atlas/api/lib/integrations/install/okf-upload-form-handler";
import { BUNDLE_SYNC_CATALOG_ID } from "@atlas/api/lib/integrations/install/bundle-sync-form-handler";
import { syncCollection } from "@atlas/api/lib/knowledge/sync";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin.knowledge");

/** Module-level content-mode registry — reused for "upload & publish" promotion. */
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bust the per-mode knowledge disk mirror (#4208, ADR-0028 §3) so the next
 * `explore` call rebuilds the `knowledge/` subtree from the DB. Reuses the
 * semantic layer's mode-root invalidation — `invalidateOrgModeRoots` busts every
 * mode for the org — the same lazy-rebuild machinery that backs entity serving.
 * Lazy-imported (not a top-level import) so the admin
 * router's static graph doesn't require `semantic/sync` at load time, matching
 * the reconcile posture in `admin-publish.ts`; best-effort, since the DB write has
 * already committed and a stale in-process cache self-heals on the next boot.
 */
async function invalidateKnowledgeMirror(orgId: string): Promise<void> {
  try {
    const { invalidateOrgModeRoots } = await import("@atlas/api/lib/semantic/sync");
    invalidateOrgModeRoots(orgId);
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to invalidate knowledge mirror — the agent may serve a stale knowledge/ subtree until the next rebuild",
    );
  }
}

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

/**
 * Map a knowledge catalog id to the wire `source` discriminator — matching
 * each KNOWN catalog explicitly so a future third knowledge catalog can never
 * default into a privileged branch (`upload` is the source that inherits the
 * upload-&-publish ingest route, ADR-0028 §4). Both gated routes reject
 * `"unknown"` outright; only the list rendering maps it to a wire label.
 */
function sourceOf(catalogId: string): "upload" | "bundle-sync" | "unknown" {
  if (catalogId === OKF_UPLOAD_CATALOG_ID) return "upload";
  if (catalogId === BUNDLE_SYNC_CATALOG_ID) return "bundle-sync";
  return "unknown";
}

/**
 * Run `fn` inside a transaction on a dedicated internal-DB client. Mirrors the
 * BEGIN/COMMIT/ROLLBACK + `release(err)` discipline in `admin-publish.ts`: a
 * failed ROLLBACK destroys the client so a dirty connection can't poison the
 * next borrower.
 */
async function withTransaction<T>(fn: (client: InternalPoolClient) => Promise<T>): Promise<T> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let rollbackErr: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { err: rollbackErr.message },
        "ROLLBACK failed after knowledge transaction error — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
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
          schema: z.object({
            collections: z.array(
              z.object({
                slug: z.string(),
                source: z.enum(["upload", "bundle-sync"]),
                description: z.string().nullable(),
                installedAt: z.string().nullable(),
                endpointUrl: z.string().nullable(),
                sync: CollectionSyncStatusSchema.nullable(),
                documents: z.object({
                  draft: z.number().int().nonnegative(),
                  published: z.number().int().nonnegative(),
                  archived: z.number().int().nonnegative(),
                }),
              }),
            ),
          }),
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
        "application/json": {
          schema: z.object({
            collection: z.string(),
            documents: z.array(KnowledgeDocumentSchema),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Collection not found or no internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
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
        "application/json": {
          schema: z.object({
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
          }),
        },
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
  summary: "Sync a bundle-sync collection now",
  description:
    "Manually pull a synced collection's bundle endpoint and apply the diff immediately (the same " +
    "run the scheduled sync performs — daily by default, operator-tunable). Changed and new documents land as `draft` for review — " +
    "synced content has no publish shortcut; paths absent from the fetched bundle are archived, " +
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
      description: "Not a synced collection (upload collections have no endpoint to sync)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Collection not found or no internal database", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
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
        "application/json": {
          schema: z.object({
            archived: z.boolean(),
            collection: z.string(),
            archivedDocuments: z.number().int().nonnegative(),
          }),
        },
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
        `SELECT collection_id, status, COUNT(*)::int AS n
           FROM knowledge_documents
          WHERE workspace_id = $1
          GROUP BY collection_id, status`,
        [orgId],
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
        collections: installs.map((r) => {
          const description = r.config?.description;
          const source = sourceOf(r.catalog_id);
          const endpointUrl = r.config?.endpoint_url;
          return {
            slug: r.install_id,
            // Wire enum is two-valued; an unknown catalog (unreachable today —
            // only the two built-in catalogs can create knowledge installs)
            // renders as "upload" but NEVER gains upload privileges: both
            // gated routes check `sourceOf` directly and reject "unknown".
            source: source === "bundle-sync" ? ("bundle-sync" as const) : ("upload" as const),
            description: typeof description === "string" ? description : null,
            installedAt: r.installed_at,
            // Non-secret by construction — the auth secret lives only in
            // knowledge_sync_credentials, never in config.
            endpointUrl:
              source === "bundle-sync" && typeof endpointUrl === "string" ? endpointUrl : null,
            sync: source === "bundle-sync" ? syncBySlug.get(r.install_id) ?? null : null,
            documents: countsBySlug.get(r.install_id) ?? { draft: 0, published: 0, archived: 0 },
          };
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

    const rows = await internalQuery<{
      id: string;
      path: string;
      title: string | null;
      description: string | null;
      type: string | null;
      tags: unknown;
      status: string;
      updated_at: string | null;
    }>(
      `SELECT id,
              path,
              title,
              description,
              type,
              tags,
              status,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM knowledge_documents
        WHERE workspace_id = $1 AND collection_id = $2 AND status <> 'archived'
        ORDER BY path ASC`,
      [orgId, collectionSlug],
    );

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
          tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
          // The archived filter above guarantees draft | published only.
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

    // Read the raw bundle bytes. The total-size cap is the first line of defense
    // against a decompression bomb (the streaming extractor enforces the decoded
    // cap too). Reject on the declared Content-Length BEFORE reading the body,
    // so an obviously-oversized upload fails immediately; the client-supplied
    // header is advisory, so the body is then STREAMED with a cumulative cap
    // (the same `readBodyWithCap` guard the sync fetch uses) — a chunked or
    // lying upload aborts the moment it crosses the limit instead of fully
    // materializing in memory first.
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
    if (bytes.length === 0) {
      return c.json({ error: "empty_bundle", message: "The uploaded bundle is empty.", requestId }, 400);
    }

    // ── Extract (in memory) → parse leniently ───────────────────────────────
    let extracted: ReturnType<typeof extractBundle>;
    try {
      extracted = extractBundle(bytes, {
        maxDocBytes: getIngestMaxDocBytes(),
        maxTotalBytes: maxBundleBytes,
      });
    } catch (err) {
      if (err instanceof BundleFormatError) {
        return c.json({ error: "invalid_bundle", message: err.message, requestId }, 400);
      }
      throw err;
    }

    const parsed = parseLenientBundle(extracted.files);
    // Per-file rejections from BOTH stages, surfaced together — never silently
    // dropped (AC #2).
    const rejected = [...extracted.errors, ...parsed.errors];

    const maxDocs = getIngestMaxDocs();
    if (parsed.docs.length > maxDocs) {
      return c.json(
        {
          error: "too_many_documents",
          message: `Bundle has ${parsed.docs.length} documents, over the ${maxDocs}-document limit.`,
          requestId,
        },
        400,
      );
    }
    if (parsed.docs.length === 0) {
      return c.json(
        {
          error: "no_documents",
          message:
            rejected.length > 0
              ? "No ingestable documents — every file was rejected. See `rejected` for per-file reasons."
              : "No ingestable markdown documents found in the bundle.",
          requestId,
          rejected,
        },
        400,
      );
    }

    // ── Ingest (+ optional atomic publish) in one transaction ───────────────
    const report = await withTransaction(async (client) => {
      const ingestReport = await ingestBundleIntoCollection({
        client,
        workspaceId: orgId,
        collectionId: collectionSlug,
        // v0 has only the explicit upload source; connector syncs (later) never
        // reach this route and never get the publish option (ADR-0028 §4).
        source: "upload",
        docs: parsed.docs,
      });

      if (shouldPublish) {
        // "Upload & publish" — promote through the SAME content-mode phases the
        // atomic publish endpoint uses, inside this transaction, so the ingested
        // drafts go live atomically with the upload (ADR-0028 §4; content-mode.md
        // "promoted inside the existing transaction"). Never a bespoke status
        // stamp outside the publish mechanism. NOTE: `runPublishPhases` is
        // workspace-wide (ADR-0028 §4 "runs that same endpoint") — it promotes
        // EVERY pending draft in the workspace across all content-mode tables
        // (other knowledge collections, entities, prompts, connections), not just
        // this bundle's docs, exactly as clicking Publish would. The registry's
        // adapters only call `.query()` — the same minimal-client cast
        // admin-publish.ts uses.
        await Effect.runPromise(
          contentModeRegistry.runPublishPhases(client as unknown as PoolClient, orgId),
        );
      }

      return ingestReport;
    });

    // Rebuild the knowledge mirror: new/updated drafts appear in developer mode
    // immediately, and an "upload & publish" surfaces in published mode too.
    await invalidateKnowledgeMirror(orgId);

    logAdminAction({
      actionType: ADMIN_ACTIONS.knowledge.ingest,
      targetType: "knowledge",
      targetId: collectionSlug,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: {
        collectionSlug,
        format: extracted.format,
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
      { requestId, orgId, collectionSlug, format: extracted.format, ...report, published: shouldPublish, rejected: rejected.length },
      "Knowledge bundle ingested",
    );

    return c.json(
      {
        collection: collectionSlug,
        format: extracted.format,
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
        rejected,
        skippedNonMarkdown: parsed.skippedNonMarkdown,
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
    if (sourceOf(collection.catalog_id) !== "bundle-sync") {
      return c.json(
        {
          error: "not_synced_collection",
          message: `"${collectionSlug}" is not a synced collection — only bundle-sync collections have an endpoint to sync.`,
          requestId,
        },
        400,
      );
    }

    // `syncCollection` never throws: fetch hardening, ingest, archive-absent,
    // and the knowledge_sync_state upsert all happen inside. A failed attempt
    // comes back as `status: "error"` with a host-redacted, actionable message.
    const outcome = await syncCollection({
      workspaceId: orgId,
      collectionSlug,
      config: collection.config,
    });

    logAdminAction({
      actionType: ADMIN_ACTIONS.knowledge.sync,
      targetType: "knowledge",
      targetId: collectionSlug,
      scope: "workspace",
      status: outcome.status === "success" ? "success" : "failure",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: {
        collectionSlug,
        status: outcome.status,
        error: outcome.error,
        format: outcome.format,
        ...(outcome.documents ?? {}),
        archivedAbsent: outcome.archivedAbsent,
        rejected: outcome.rejected.length,
      },
    });

    log.info(
      { requestId, orgId, collectionSlug, status: outcome.status, error: outcome.error },
      "Knowledge collection manual sync completed",
    );

    return c.json(
      {
        collection: outcome.collection,
        status: outcome.status,
        syncedAt: outcome.syncedAt,
        error: outcome.error,
        format: outcome.format,
        documents: outcome.documents,
        archivedAbsent: outcome.archivedAbsent,
        linksWritten: outcome.linksWritten,
        rejected: [...outcome.rejected],
      } satisfies KnowledgeSyncRunResponse,
      200,
    );
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

    // Archive the collection container + its documents in one transaction.
    // Documents are ARCHIVED, never hard-deleted (ADR-0028 §5); `knowledge_links`
    // cascade only on document DELETE, so archiving leaves the graph intact
    // (link visibility follows its source document's status). Sync bookkeeping
    // and the endpoint credential (bundle-sync collections, #4211) are
    // hard-DELETED — secrets never outlive their install, and both are no-op
    // for upload collections.
    const archivedDocuments = await withTransaction(async (client) => {
      await client.query(
        `UPDATE workspace_plugins
            SET status = 'archived', enabled = false, updated_at = NOW()
          WHERE workspace_id = $1 AND install_id = $2 AND pillar = 'knowledge'`,
        [orgId, collectionSlug],
      );
      const docs = await client.query(
        `UPDATE knowledge_documents
            SET status = 'archived', updated_at = NOW()
          WHERE workspace_id = $1 AND collection_id = $2 AND status <> 'archived'
          RETURNING id`,
        [orgId, collectionSlug],
      );
      await client.query(
        `DELETE FROM knowledge_sync_credentials
          WHERE workspace_id = $1 AND collection_id = $2`,
        [orgId, collectionSlug],
      );
      await client.query(
        `DELETE FROM knowledge_sync_state
          WHERE workspace_id = $1 AND collection_id = $2`,
        [orgId, collectionSlug],
      );
      return docs.rows.length;
    });

    // Archived documents must drop out of both the published and developer
    // mirrors on the next explore call.
    await invalidateKnowledgeMirror(orgId);

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

export { adminKnowledge };
