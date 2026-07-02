/**
 * `ingestBundle()` — the ONE orchestration seam from raw bundle bytes to
 * committed `knowledge_documents` rows.
 *
 * Milestone #81 shipped this band (extract → parse leniently → caps →
 * empty-check → transaction → mirror invalidation) copy-adapted twice: once
 * inline in the admin upload route, once in the sync engine. The two callers
 * only ever differed in DISPOSITION — upload maps failures to HTTP 400s, sync
 * maps the same failures to a `status:"error"` sync-state row — so the shared
 * band lives here as one deep module returning a typed outcome, and each
 * caller is an adapter that words its own failure messages. A third caller
 * (the ADR-0028 Notion/Confluence connector follow-ups) calls this seam, not a
 * third copy.
 *
 * Invariants owned here (not re-remembered by callers):
 *   - every ingest lands `draft` (via the ingest core's review gate);
 *   - promotion happens ONLY through the content-mode publish phases, in the
 *     same transaction (`publish: true` — the "upload & publish" convenience;
 *     callers enforce ADR-0028 §4's upload-only pairing);
 *   - the subtractive diff (`archiveAbsent: true` — sync semantics) shares the
 *     ingest transaction, so a sync is all-or-nothing;
 *   - the knowledge mirror is invalidated exactly when the committed write
 *     changed something visible (any churn, or a publish).
 */

import type { PoolClient } from "pg";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { withInternalTransaction } from "@atlas/api/lib/db/with-internal-transaction";
import {
  extractBundle,
  BundleFormatError,
  type BundleEntryError,
  type ExtractedBundle,
} from "./bundle-archive";
import { parseLenientBundle } from "./parse-lenient";
import {
  ingestBundleIntoCollection,
  type IngestClient,
  type IngestReport,
  type IngestSource,
} from "./ingest";
import {
  getIngestMaxBundleBytes,
  getIngestMaxDocBytes,
  getIngestMaxDocs,
} from "./ingest-limits";
import { archiveCollectionDocuments } from "./collection-lifecycle";
import { invalidateKnowledgeMirror } from "./mirror-invalidation";

const log = createLogger("knowledge-ingest-bundle");

/** Module-level content-mode registry — reused for "upload & publish" promotion. */
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

export type BundleFormat = ExtractedBundle["format"];

export interface IngestBundleParams {
  readonly workspaceId: string;
  /** The owning collection = the `workspace_plugins.install_id` slug. */
  readonly collectionId: string;
  readonly source: IngestSource;
  /** Raw bundle bytes (`.tar` / `.tar.gz` / `.zip`), UNTRUSTED third-party input. */
  readonly bytes: Uint8Array;
  /**
   * Run the workspace-wide content-mode publish phases in the SAME transaction
   * ("upload & publish", ADR-0028 §4). Callers enforce the upload-only pairing —
   * the sync engine never sets this.
   */
  readonly publish?: boolean;
  /**
   * Archive previously-ingested docs whose paths are absent from this bundle
   * (sync semantics: the endpoint owns the tree). Absent = not among the parsed
   * docs AND not among per-file rejections — a present-but-broken file must not
   * archive its previously-reviewed document.
   */
  readonly archiveAbsent?: boolean;
}

/** A failed ingest — each `kind` is one caller-facing disposition. */
export type IngestBundleFailure =
  | { readonly kind: "empty_bundle" }
  | { readonly kind: "bundle_too_large"; readonly bytes: number; readonly maxBundleBytes: number }
  | { readonly kind: "invalid_bundle"; readonly message: string }
  | {
      readonly kind: "too_many_documents";
      readonly count: number;
      readonly maxDocs: number;
      readonly rejected: readonly BundleEntryError[];
    }
  | { readonly kind: "no_documents"; readonly rejected: readonly BundleEntryError[] };

export type IngestBundleOutcome =
  | {
      readonly kind: "ok";
      readonly format: BundleFormat;
      readonly report: IngestReport;
      /** Docs archived because their path left the bundle; null unless `archiveAbsent`. */
      readonly archivedAbsent: number | null;
      readonly published: boolean;
      /** Per-file rejections from extraction + lenient parsing — never silently dropped. */
      readonly rejected: readonly BundleEntryError[];
    }
  | IngestBundleFailure;

/**
 * Ingest a raw bundle into a collection. Returns a typed outcome for every
 * expected failure; only infrastructure errors (DB down, transaction failure)
 * throw — callers decide whether that's a 500 (upload) or an error outcome
 * (sync).
 */
export async function ingestBundle(params: IngestBundleParams): Promise<IngestBundleOutcome> {
  const { workspaceId, collectionId, source, bytes } = params;
  const publish = params.publish === true;
  const archiveAbsent = params.archiveAbsent === true;

  // ADR-0028 §4 as a property of the seam, not a caller convention: connector-
  // style ingest (bundle-sync, future Notion/Confluence) can never pair with
  // the atomic publish — synced third-party content always queues for review.
  if (publish && source !== "upload") {
    throw new Error(
      `ingestBundle: publish is only valid for source "upload" (ADR-0028 §4) — got "${source}"`,
    );
  }

  const maxBundleBytes = getIngestMaxBundleBytes();
  if (bytes.length === 0) return { kind: "empty_bundle" };
  if (bytes.length > maxBundleBytes) {
    return { kind: "bundle_too_large", bytes: bytes.length, maxBundleBytes };
  }

  // ── Extract (in memory) → parse leniently ─────────────────────────────────
  let extracted: ExtractedBundle;
  try {
    extracted = extractBundle(bytes, {
      maxDocBytes: getIngestMaxDocBytes(),
      maxTotalBytes: maxBundleBytes,
    });
  } catch (err) {
    if (err instanceof BundleFormatError) {
      return { kind: "invalid_bundle", message: err.message };
    }
    throw err;
  }

  const parsed = parseLenientBundle(extracted.files);
  // Per-file rejections from BOTH stages, surfaced together.
  const rejected: BundleEntryError[] = [...extracted.errors, ...parsed.errors];

  const maxDocs = getIngestMaxDocs();
  if (parsed.docs.length > maxDocs) {
    return { kind: "too_many_documents", count: parsed.docs.length, maxDocs, rejected };
  }
  if (parsed.docs.length === 0) {
    return { kind: "no_documents", rejected };
  }

  // ── Ingest (+ optional archive-absent + optional publish) in ONE tx ───────
  const presentPaths = [...parsed.docs.map((d) => d.path), ...rejected.map((r) => r.path)];
  const { report, archivedAbsent } = await withInternalTransaction(
    "knowledge-ingest-bundle",
    async (client) => {
      // `InternalPoolClient.query` is non-generic, so it can't structurally
      // satisfy `IngestClient`'s generic `query<T>` without a cast — the same
      // unchecked-DB-row seam the `PoolClient` cast below uses.
      const ingestClient = client as unknown as IngestClient;
      const ingestReport = await ingestBundleIntoCollection({
        client: ingestClient,
        workspaceId,
        collectionId,
        source,
        docs: parsed.docs,
      });
      const archivedCount = archiveAbsent
        ? await archiveCollectionDocuments(ingestClient, workspaceId, collectionId, {
            exceptPaths: presentPaths,
          })
        : null;
      if (publish) {
        // Promote through the SAME content-mode phases the atomic publish
        // endpoint uses, inside this transaction. NOTE: `runPublishPhases` is
        // workspace-wide (ADR-0028 §4 "runs that same endpoint") — it promotes
        // EVERY pending draft in the workspace across all content-mode tables,
        // not just this bundle's docs, exactly as clicking Publish would.
        await Effect.runPromise(
          contentModeRegistry.runPublishPhases(client as unknown as PoolClient, workspaceId),
        );
      }
      return { report: ingestReport, archivedAbsent: archivedCount };
    },
  );

  // Invalidate exactly when the committed write changed something visible:
  // draft churn surfaces in developer mode, a publish surfaces in published
  // mode too. An all-unchanged ingest skips the (entity-root-wide) rebuild.
  const churn =
    report.created + report.updated + report.demoted + report.resurrected + (archivedAbsent ?? 0);
  if (churn > 0 || publish) {
    await invalidateKnowledgeMirror(workspaceId);
  }

  log.info(
    { workspaceId, collectionId, source, format: extracted.format, ...report, archivedAbsent, published: publish, rejected: rejected.length },
    "Knowledge bundle ingested",
  );

  return {
    kind: "ok",
    format: extracted.format,
    report,
    archivedAbsent,
    published: publish,
    rejected,
  };
}
