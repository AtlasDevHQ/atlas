/**
 * `admin-knowledge` — the Knowledge Base pillar's admin surface (#4207,
 * ADR-0028). Mounted under `/api/v1/admin/knowledge`; the one-surface-per-pillar
 * admin home for hosted OKF collections.
 *
 * A *collection* is a `pillar='knowledge'` `workspace_plugins` install
 * (`install_id` = slug). Installing one goes through the shared form-install
 * pipeline (`POST /api/v1/integrations/okf-upload/install-form` →
 * `OkfUploadFormInstallHandler`); this router owns the post-install lifecycle:
 *
 *   - `GET  /`                          — list the workspace's collections + doc counts
 *   - `GET  /{collectionSlug}/documents` — list a collection's documents + status
 *   - `POST /{collectionSlug}/ingest`   — upload an OKF bundle into a collection
 *   - `DELETE /{collectionSlug}`        — uninstall (archive docs, never delete)
 *
 * Ingest is the heart of the slice. The uploaded `.tar` / `.tar.gz` / `.zip`
 * bundle is UNTRUSTED third-party input: it is walked in memory (no fs), each
 * document parsed leniently (OKF is the at-rest normal form, not an ingest
 * requirement), and upserted by path at `status='draft'` — the review gate.
 * `?publish=true` ("upload & publish") runs the atomic content-mode promotion in
 * the SAME transaction (ADR-0028 §4); a future connector sync gets no such
 * option and always queues for review.
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
import {
  ingestBundleIntoCollection,
  type IngestClient,
} from "@atlas/api/lib/knowledge/ingest";
import {
  getIngestMaxDocs,
  getIngestMaxDocBytes,
  getIngestMaxBundleBytes,
} from "@atlas/api/lib/knowledge/ingest-limits";
import { OKF_UPLOAD_CATALOG_ID } from "@atlas/api/lib/integrations/install/okf-upload-form-handler";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin.knowledge");

/** Module-level content-mode registry — reused for "upload & publish" promotion. */
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load one collection install scoped to the workspace, or null. */
async function loadCollection(
  orgId: string,
  slug: string,
): Promise<{ install_id: string; status: string; config: Record<string, unknown> | null } | null> {
  const rows = await internalQuery<{
    install_id: string;
    status: string;
    config: Record<string, unknown> | null;
  }>(
    `SELECT install_id, status, config
       FROM workspace_plugins
      WHERE workspace_id = $1 AND install_id = $2
        AND catalog_id = $3 AND pillar = 'knowledge'
      LIMIT 1`,
    [orgId, slug, OKF_UPLOAD_CATALOG_ID],
  );
  return rows[0] ?? null;
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

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Knowledge"],
  summary: "List knowledge collections",
  description:
    "List the workspace's Knowledge Base collections (excluding archived) with per-status document counts.",
  responses: {
    200: {
      description: "Collection list",
      content: {
        "application/json": {
          schema: z.object({
            collections: z.array(
              z.object({
                slug: z.string(),
                description: z.string().nullable(),
                installedAt: z.string().nullable(),
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

const deleteRoute = createRoute({
  method: "delete",
  path: "/{collectionSlug}",
  tags: ["Admin — Knowledge"],
  summary: "Uninstall a knowledge collection",
  description:
    "Uninstall a collection: its documents are ARCHIVED (status='archived'), never hard-deleted, and the " +
    "collection install is archived. A later re-install does not resurrect the archived documents.",
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
    const [installs, counts] = await Promise.all([
      internalQuery<{ install_id: string; config: Record<string, unknown> | null; installed_at: string | null }>(
        `SELECT install_id,
                config,
                to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS installed_at
           FROM workspace_plugins
          WHERE workspace_id = $1 AND catalog_id = $2 AND pillar = 'knowledge'
            AND status <> 'archived'
          ORDER BY installed_at ASC`,
        [orgId, OKF_UPLOAD_CATALOG_ID],
      ),
      internalQuery<{ collection_id: string; status: string; n: number }>(
        `SELECT collection_id, status, COUNT(*)::int AS n
           FROM knowledge_documents
          WHERE workspace_id = $1
          GROUP BY collection_id, status`,
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

    return c.json(
      {
        collections: installs.map((r) => {
          const description = r.config?.description;
          return {
            slug: r.install_id,
            description: typeof description === "string" ? description : null,
            installedAt: r.installed_at,
            documents: countsBySlug.get(r.install_id) ?? { draft: 0, published: 0, archived: 0 },
          };
        }),
      },
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
      },
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

    // Read the raw bundle bytes. The total-size cap is the first line of defense
    // against a decompression bomb (the streaming extractor enforces the decoded
    // cap too). Reject on the declared Content-Length BEFORE buffering the body,
    // so an obviously-oversized upload never fully materializes in memory; the
    // client-supplied header is advisory, so the post-buffer check below stays as
    // the authoritative guard.
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
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) {
      return c.json({ error: "empty_bundle", message: "The uploaded bundle is empty.", requestId }, 400);
    }
    if (bytes.length > maxBundleBytes) {
      return c.json(
        {
          error: "bundle_too_large",
          message: `Bundle is ${bytes.length} bytes, over the ${maxBundleBytes}-byte limit.`,
          requestId,
        },
        400,
      );
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
        // `InternalPoolClient.query` is non-generic, so it can't structurally
        // satisfy `IngestClient`'s generic `query<T>` without a cast — the same
        // unchecked-DB-row seam the `PoolClient` cast below uses. The ingest core
        // only calls `.query()`.
        client: client as unknown as IngestClient,
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
      },
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
    // (link visibility follows its source document's status).
    const archivedDocuments = await withTransaction(async (client) => {
      await client.query(
        `UPDATE workspace_plugins
            SET status = 'archived', enabled = false, updated_at = NOW()
          WHERE workspace_id = $1 AND install_id = $2
            AND catalog_id = $3 AND pillar = 'knowledge'`,
        [orgId, collectionSlug, OKF_UPLOAD_CATALOG_ID],
      );
      const docs = await client.query(
        `UPDATE knowledge_documents
            SET status = 'archived', updated_at = NOW()
          WHERE workspace_id = $1 AND collection_id = $2 AND status <> 'archived'
          RETURNING id`,
        [orgId, collectionSlug],
      );
      return docs.rows.length;
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

    return c.json({ archived: true, collection: collectionSlug, archivedDocuments }, 200);
  }),
);

export { adminKnowledge };
