/**
 * The ONE orchestration seam from incoming knowledge content to committed
 * `knowledge_documents` rows — split at document level (#4376, ADR-0030):
 *
 *   - `ingestDocuments()` — documents → transaction. Parse leniently → caps →
 *     install re-check → upsert-by-path (+ optional archive-absent + optional
 *     publish) in ONE transaction → mirror invalidation. Knowledge Sync
 *     Connectors enter HERE: they already hold collected documents (path +
 *     content) from `@atlas/okf-bundle`'s collect machinery, so there is no
 *     tar round-trip inside the process (the collect/pack invariant from
 *     #4373 paying off).
 *   - `ingestBundle()` — bytes → documents. Container handling only (size
 *     caps, archive extraction), then delegates to `ingestDocuments`. The
 *     upload route and the bundle-sync engine are unchanged consumers.
 *
 * Milestone #81 shipped this band (extract → parse leniently → caps →
 * empty-check → transaction → mirror invalidation) copy-adapted twice: once
 * inline in the admin upload route, once in the sync engine. The two callers
 * only ever differed in DISPOSITION — upload maps failures to HTTP 400s, sync
 * maps the same failures to a `status:"error"` sync-state row — so the shared
 * band lives here as one deep module returning a typed outcome, and each
 * caller is an adapter that words its own failure messages.
 *
 * Invariants owned here (not re-remembered by callers):
 *   - every ingest lands `draft` (via the ingest core's review gate);
 *   - promotion happens ONLY through the content-mode publish phases, in the
 *     same transaction (`publish: true` — the "upload & publish" convenience;
 *     the seam itself rejects `publish` for non-upload sources, ADR-0028 §4 —
 *     connectors structurally cannot publish);
 *   - the subtractive diff (`archiveAbsent: true` — sync semantics) shares the
 *     ingest transaction, so a sync is all-or-nothing;
 *   - the knowledge mirror is invalidated exactly when the committed write
 *     changed something visible (any churn, or a publish).
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { CONTENT_MODE_TABLES, makeService } from "@atlas/api/lib/content-mode";
import { withInternalTransaction } from "@atlas/api/lib/db/with-internal-transaction";
import type { InteropFile } from "@atlas/api/lib/semantic/okf";
import {
  extractBundle,
  BundleFormatError,
  type BundleEntryError,
  type ExtractedBundle,
} from "./bundle-archive";
import { parseLenientBundle } from "./parse-lenient";
import {
  ingestBundleIntoCollection,
  type IngestReport,
  type IngestSource,
} from "./ingest";
import {
  getIngestMaxBundleBytes,
  getIngestMaxDocBytes,
  getIngestMaxDocs,
} from "./ingest-limits";
import { archiveCollectionDocuments, INSTALL_RECHECK_SQL } from "./collection-lifecycle";
import { invalidateKnowledgeMirror } from "./mirror-invalidation";

const log = createLogger("knowledge-ingest-bundle");

/** Module-level content-mode registry — used only for "upload & publish" promotion. */
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
   * ("upload & publish", ADR-0028 §4). The seam rejects this for non-upload
   * sources (guard in `ingestDocuments`) — the sync engines never set it.
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

/** The document-level entry (#4376): already-extracted files → transaction. */
export interface IngestDocumentsParams {
  readonly workspaceId: string;
  /** The owning collection = the `workspace_plugins.install_id` slug. */
  readonly collectionId: string;
  readonly source: IngestSource;
  /**
   * Document files (relative path + full markdown content, frontmatter
   * included), UNTRUSTED third-party input. For connectors these are collected
   * documents from `@atlas/okf-bundle` (a `CollectedDoc.path`/`content` is
   * structurally an `InteropFile`); for bundles they are the extracted
   * archive entries.
   */
  readonly files: readonly InteropFile[];
  /** See {@link IngestBundleParams.publish} — rejected for non-upload sources. */
  readonly publish?: boolean;
  /** See {@link IngestBundleParams.archiveAbsent}. */
  readonly archiveAbsent?: boolean;
  /**
   * Per-file rejections from an upstream container stage (archive extraction),
   * folded into the outcome's `rejected` AND the archive-absent present set —
   * a file the container DID carry but could not extract must not archive its
   * previously-reviewed document.
   */
  readonly upstreamRejections?: readonly BundleEntryError[];
}

/**
 * The install row vanished (uninstalled/archived) between the caller's
 * pre-check and the write phase — the uninstall × in-flight-ingest race
 * (#4229). Thrown inside the transaction so it rolls back before any write.
 */
class InstallGoneError extends Error {
  constructor() {
    super("The collection was uninstalled while the ingest was running — no changes were applied.");
    this.name = "InstallGoneError";
  }
}

/** Failures of the document-level transaction — each `kind` is one caller-facing disposition. */
export type IngestDocumentsFailure =
  /** The uninstall × in-flight-ingest race fired: the transaction rolled back
   *  before any write. `rejected` carries the parse-stage per-file errors
   *  observed before the abort. */
  | { readonly kind: "install_gone"; readonly rejected: readonly BundleEntryError[] }
  | {
      readonly kind: "too_many_documents";
      readonly count: number;
      readonly maxDocs: number;
      readonly rejected: readonly BundleEntryError[];
    }
  | { readonly kind: "no_documents"; readonly rejected: readonly BundleEntryError[] };

/** A failed ingest — the document-level failures plus the container-stage ones. */
export type IngestBundleFailure =
  | IngestDocumentsFailure
  | { readonly kind: "empty_bundle" }
  | { readonly kind: "bundle_too_large"; readonly bytes: number; readonly maxBundleBytes: number }
  | { readonly kind: "invalid_bundle"; readonly message: string };

/** The successful-transaction shape shared by both entries. */
export interface IngestDocumentsOk {
  readonly kind: "ok";
  readonly report: IngestReport;
  /** Docs archived because their path left the incoming set; null unless `archiveAbsent`. */
  readonly archivedAbsent: number | null;
  readonly published: boolean;
  /** Per-file rejections from extraction + oversize + lenient parsing — never silently dropped. */
  readonly rejected: readonly BundleEntryError[];
  /** Non-markdown / asset files skipped by design (only `.md` ingests). */
  readonly skippedNonMarkdown: number;
}

export type IngestDocumentsOutcome = IngestDocumentsOk | IngestDocumentsFailure;

export type IngestBundleOutcome =
  | (IngestDocumentsOk & { readonly format: BundleFormat })
  | IngestBundleFailure;

/**
 * Ingest document files into a collection — the document-level seam (#4376).
 * Returns a typed outcome for every expected failure; only infrastructure
 * errors (DB down, transaction failure) throw — callers decide whether that's
 * a 500 (upload) or an error outcome (sync/connector).
 */
export async function ingestDocuments(
  params: IngestDocumentsParams,
): Promise<IngestDocumentsOutcome> {
  const { workspaceId, collectionId, source, files } = params;
  const publish = params.publish === true;
  const archiveAbsent = params.archiveAbsent === true;

  // ADR-0028 §4 as a property of the seam, not a caller convention: connector-
  // style ingest (bundle-sync, `connector:*` vendors) can never pair with the
  // atomic publish — synced third-party content always queues for review.
  if (publish && source !== "upload") {
    throw new Error(
      `ingestDocuments: publish is only valid for source "upload" (ADR-0028 §4) — got "${source}"`,
    );
  }

  // ── Per-document byte cap → parse leniently ────────────────────────────────
  // The bundle path already enforced the doc cap during streaming extraction;
  // document-level callers (connectors) get the SAME cap here so an oversized
  // vendor page is a counted per-file rejection, never an unbounded row.
  const maxDocBytes = getIngestMaxDocBytes();
  const encoder = new TextEncoder();
  const oversize: BundleEntryError[] = [];
  const eligible: InteropFile[] = [];
  for (const file of files) {
    const bytes = encoder.encode(file.content).length;
    if (bytes > maxDocBytes) {
      oversize.push({
        path: file.path,
        reason: `document is ${bytes} bytes, over the ${maxDocBytes}-byte per-document limit`,
      });
      continue;
    }
    eligible.push(file);
  }

  const parsed = parseLenientBundle(eligible);
  // Per-file rejections from EVERY stage (container, oversize, parse),
  // surfaced together.
  const rejected: BundleEntryError[] = [
    ...(params.upstreamRejections ?? []),
    ...oversize,
    ...parsed.errors,
  ];

  const maxDocs = getIngestMaxDocs();
  if (parsed.docs.length > maxDocs) {
    return { kind: "too_many_documents", count: parsed.docs.length, maxDocs, rejected };
  }
  if (parsed.docs.length === 0) {
    return { kind: "no_documents", rejected };
  }

  // ── Ingest (+ optional archive-absent + optional publish) in ONE tx ───────
  const presentPaths = [...parsed.docs.map((d) => d.path), ...rejected.map((r) => r.path)];
  let report: IngestReport;
  let archivedAbsent: number | null;
  try {
    ({ report, archivedAbsent } = await withInternalTransaction(
      "knowledge-ingest-bundle",
      async (client) => {
        // Re-check the install INSIDE the transaction (`FOR UPDATE`, so this
        // serializes against a concurrent uninstall's row UPDATE): the caller
        // checked it before reading/fetching the content, but an uninstall
        // landing during that window would otherwise let this ingest resurrect
        // just-archived documents to `draft` (and, for sync, re-create the
        // bookkeeping the uninstall just deleted). Throwing aborts the
        // transaction — no write survives.
        const recheck = await client.query(INSTALL_RECHECK_SQL, [workspaceId, collectionId]);
        const liveStatus = recheck.rows[0]?.status;
        if (liveStatus === undefined || liveStatus === "archived") {
          throw new InstallGoneError();
        }
        const ingestReport = await ingestBundleIntoCollection({
          client,
          workspaceId,
          collectionId,
          source,
          docs: parsed.docs,
        });
        const archivedCount = archiveAbsent
          ? await archiveCollectionDocuments(client, workspaceId, collectionId, {
              exceptPaths: presentPaths,
            })
          : null;
        if (publish) {
          // Promote through the SAME content-mode phases the atomic publish
          // endpoint uses, inside this transaction. NOTE: `runPublishPhases` is
          // workspace-wide (ADR-0028 §4 "runs that same endpoint") — it promotes
          // EVERY pending draft in the workspace across all content-mode tables,
          // not just this bundle's docs, exactly as clicking Publish would.
          await Effect.runPromise(contentModeRegistry.runPublishPhases(client, workspaceId));
        }
        return { report: ingestReport, archivedAbsent: archivedCount };
      },
    ));
  } catch (err) {
    if (err instanceof InstallGoneError) {
      return { kind: "install_gone", rejected };
    }
    throw err;
  }

  // Invalidate exactly when the committed write changed something visible:
  // draft churn surfaces in developer mode, a publish surfaces in published
  // mode too. Plain ingest touches only the knowledge subtree; a publish is
  // workspace-wide (it promotes entity/prompt/connection drafts too), so it
  // busts the full mode roots.
  const churn =
    report.created + report.updated + report.demoted + report.resurrected + (archivedAbsent ?? 0);
  if (churn > 0 || publish) {
    await invalidateKnowledgeMirror(workspaceId, { scope: publish ? "full" : "knowledge" });
  }

  log.info(
    { workspaceId, collectionId, source, ...report, archivedAbsent, published: publish, rejected: rejected.length },
    "Knowledge documents ingested",
  );

  return {
    kind: "ok",
    report,
    archivedAbsent,
    published: publish,
    rejected,
    skippedNonMarkdown: parsed.skippedNonMarkdown,
  };
}

/**
 * Ingest a raw bundle into a collection — the container-level seam. Owns only
 * the bytes → files stage (whole-bundle size caps, archive extraction), then
 * delegates to {@link ingestDocuments}. Returns a typed outcome for every
 * expected failure; only infrastructure errors throw.
 */
export async function ingestBundle(params: IngestBundleParams): Promise<IngestBundleOutcome> {
  const { workspaceId, collectionId, source, bytes } = params;

  const maxBundleBytes = getIngestMaxBundleBytes();
  if (bytes.length === 0) return { kind: "empty_bundle" };
  if (bytes.length > maxBundleBytes) {
    return { kind: "bundle_too_large", bytes: bytes.length, maxBundleBytes };
  }

  // ── Extract (in memory), then hand the files to the document seam ─────────
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

  const outcome = await ingestDocuments({
    workspaceId,
    collectionId,
    source,
    files: extracted.files,
    publish: params.publish,
    archiveAbsent: params.archiveAbsent,
    upstreamRejections: extracted.errors,
  });
  return outcome.kind === "ok" ? { ...outcome, format: extracted.format } : outcome;
}
