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
 *   - a publish REPORTS what it superseded (#4937) — see
 *     {@link IngestDocumentsOk.supersededFacts};
 *   - the subtractive diff (`archiveAbsent: true` — sync semantics) shares the
 *     ingest transaction, so a sync is all-or-nothing;
 *   - the knowledge mirror is invalidated exactly when the committed write
 *     changed something visible (any churn, or a publish).
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import {
  CONTENT_MODE_TABLES,
  collectSupersessions,
  countSupersessionsHeldBack,
  makeService,
  type SupersessionRecord,
} from "@atlas/api/lib/content-mode";
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
  assertIngestCapsFor,
  resolveIngestCaps,
  type CapBoundBy,
  type EffectiveIngestCaps,
} from "@atlas/api/lib/billing/knowledge-limits";
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
  /**
   * Pre-resolved effective caps (`min(platform ceiling, plan tier)`, #4235).
   * Optional: when omitted the seam resolves them itself from `workspaceId`.
   * Callers that already had to resolve them — the upload route, which caps the
   * raw request body before it reads it, and `ingestBundle`, which caps bytes
   * before handing files to the document seam — pass theirs so ONE tier lookup
   * governs the whole ingest and the two stages can't disagree.
   */
  readonly caps?: EffectiveIngestCaps;
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
  /**
   * Pre-resolved effective caps (`min(platform ceiling, plan tier)`, #4235).
   * Optional: when omitted the seam resolves them itself from `workspaceId`.
   * Callers that already had to resolve them — the upload route, which caps the
   * raw request body before it reads it, and `ingestBundle`, which caps bytes
   * before handing files to the document seam — pass theirs so ONE tier lookup
   * governs the whole ingest and the two stages can't disagree.
   */
  readonly caps?: EffectiveIngestCaps;
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
      /**
       * Which cap bound (#4235): `"tier"` means the workspace's plan — not the
       * fleet-wide operator ceiling — refused the bundle, so the caller owes an
       * upgrade prompt rather than a flat "too many documents".
       */
      readonly boundBy: CapBoundBy;
      readonly rejected: readonly BundleEntryError[];
    }
  | { readonly kind: "no_documents"; readonly rejected: readonly BundleEntryError[] };

/** A failed ingest — the document-level failures plus the container-stage ones. */
export type IngestBundleFailure =
  | IngestDocumentsFailure
  | { readonly kind: "empty_bundle" }
  | {
      readonly kind: "bundle_too_large";
      readonly bytes: number;
      readonly maxBundleBytes: number;
      /** See {@link IngestDocumentsFailure} `too_many_documents.boundBy` (#4235). */
      readonly boundBy: CapBoundBy;
    }
  | { readonly kind: "invalid_bundle"; readonly message: string };

/** The successful-transaction shape shared by both entries. */
export interface IngestDocumentsOk {
  readonly kind: "ok";
  readonly report: IngestReport;
  /** Docs archived because their path left the incoming set; null unless `archiveAbsent`. */
  readonly archivedAbsent: number | null;
  readonly published: boolean;
  /**
   * Published brain facts this ingest's publish SUPERSEDED (#4912, #4937).
   * Always `[]` when `published` is false — the flag, not an absent field, is
   * what says "no publish ran here", so a caller never has to distinguish
   * `undefined` from "superseded nothing".
   *
   * Reported rather than discarded because `runPublishPhases` is workspace-wide:
   * an "upload & publish" promotes every pending draft in the workspace, so it
   * can retire a belief this bundle never mentioned. Stamping `valid_to` hides
   * the superseded fact from every as-of-now read the instant the transaction
   * commits, which makes an unrecorded stamp invisible by construction — the
   * durable record is the other half of #4912's human gate.
   *
   * **Disclosure posture: after-the-fact record, deliberately (#4937 AC2).**
   * The console's publish surface discloses BEFORE the click
   * (`admin-publish-preview.ts`'s `brainFactsWillSupersede` → the confirm
   * modal); an upload is a single-shot request with no confirm step, so there
   * is nowhere to put a pre-disclosure without splitting the endpoint into
   * preview + commit. That is not a gap in the gate: the facts a publish
   * supersedes are pending brain drafts that ALREADY existed in the workspace
   * — a bundle of markdown documents mints none: this seam writes
   * `knowledge_documents` only, and the `brain_episodes` writers are
   * `brain/ingest/episodes.ts` plus the correction and region-import paths,
   * none reachable from here — so those supersessions are disclosable in
   * the publish preview independently of this upload. Two caveats keep that an
   * argument rather than a proof: the extraction fiber mints drafts on its own
   * clock, so a preview fetched earlier is not guaranteed to be the same set,
   * and a scripted caller of the ingest endpoint never opens the preview at
   * all. What only this path can record is what actually happened, and that is
   * what rides here → the route's `audit_log` row.
   */
  readonly supersededFacts: readonly SupersessionRecord[];
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
  // A caller-supplied cap object is the one place another tenant's plan limit
  // could be applied here, so it is checked against this ingest's workspace.
  if (params.caps) assertIngestCapsFor(params.caps, workspaceId);
  const caps = params.caps ?? (await resolveIngestCaps(workspaceId));
  const maxDocBytes = caps.maxDocBytes;
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

  const { value: maxDocs, boundBy } = caps.maxDocs;
  if (parsed.docs.length > maxDocs) {
    return { kind: "too_many_documents", count: parsed.docs.length, maxDocs, boundBy, rejected };
  }
  if (parsed.docs.length === 0) {
    return { kind: "no_documents", rejected };
  }

  // ── Ingest (+ optional archive-absent + optional publish) in ONE tx ───────
  const presentPaths = [...parsed.docs.map((d) => d.path), ...rejected.map((r) => r.path)];
  let report: IngestReport;
  let archivedAbsent: number | null;
  let supersededFacts: readonly SupersessionRecord[];
  try {
    ({ report, archivedAbsent, supersededFacts } = await withInternalTransaction(
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
        let superseded: readonly SupersessionRecord[] = [];
        if (publish) {
          // Promote through the SAME content-mode phases the atomic publish
          // endpoint uses, inside this transaction. NOTE: `runPublishPhases` is
          // workspace-wide (ADR-0028 §4 "runs that same endpoint") — it promotes
          // EVERY pending draft in the workspace across all content-mode tables,
          // not just this bundle's docs, exactly as clicking Publish would.
          const reports = await Effect.runPromise(
            contentModeRegistry.runPublishPhases(client, workspaceId),
          );
          // Since #4912 that workspace-wide promotion can stamp `valid_to` on
          // published brain facts, so the reports are NOT discardable here —
          // dropping them made this the one publish path that retired a belief
          // with no record of what replaced it (#4937). Swept with the SAME
          // helper `admin-publish.ts` and the MCP seam use, for
          // `collectRefusals`' stated reason: one sweep, nothing to keep in
          // sync by hand. NOTE this path sweeps ONLY the supersessions (the
          // deliberate #4937 scope): a refusal or a widening here reaches the
          // adapter's own log line and no durable record — and the widening
          // line SAMPLES at 20 ids, so discarding the report truncates it. See
          // `promoted.ts`.
          superseded = collectSupersessions(reports);
          // #5033's complement, on the same terms as the sweep above — and it
          // is LOGGED here rather than returned, because unlike `superseded`
          // this seam's callers have no field to put it in. `null` (could not
          // be computed) is distinguished from 0 for the reason `port.ts`
          // gives: this path keeps no durable record, so the log line is all
          // there is and it must not claim a number it does not have.
          const heldBack = countSupersessionsHeldBack(reports);
          if (heldBack === null) {
            log.warn(
              { workspaceId },
              "Upload & publish committed, but the tier-held-back count could not be computed — if any collisions were withheld on trust-tier grounds, nothing records them",
            );
          } else if (heldBack > 0) {
            log.warn(
              { workspaceId, heldBack },
              "Upload & publish committed and DECLINED to supersede one or more provable collisions — one side is warehouse-derived (tier-1) or carries an unclassifiable source kind, so both claims stay current and in tension; this path keeps no audit row",
            );
          }
        }
        return {
          report: ingestReport,
          archivedAbsent: archivedCount,
          supersededFacts: superseded,
        };
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
    { workspaceId, collectionId, source, ...report, archivedAbsent, published: publish, rejected: rejected.length, superseded: supersededFacts.length },
    "Knowledge documents ingested",
  );

  // Its own line, at warn, for the reason `mcp-lifecycle.ts` warns: a
  // supersession permanently changed which claim answers as-of-now reads, and
  // the retired side is hidden from every default read from here on. Uncapped —
  // "which facts" is the entire point, and unlike the adapter's own sampled
  // line this one is the seam's complete list. The upload route mirrors it into
  // `audit_log`; this fires at the seam, so a future caller that publishes
  // without an audit row still leaves a trace. (Today's other callers —
  // connector sync and the bundle-sync engine — structurally cannot publish,
  // ADR-0028 §4, so this is forward coverage rather than a live second case.)
  if (supersededFacts.length > 0) {
    log.warn(
      {
        workspaceId,
        collectionId,
        supersededCount: supersededFacts.length,
        superseded: supersededFacts,
      },
      "Upload & publish SUPERSEDED one or more published brain facts — their valid_to is stamped and as-of-now reads now hide them; the facts stay readable to as-of reads",
    );
  }

  return {
    kind: "ok",
    report,
    archivedAbsent,
    published: publish,
    supersededFacts,
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

  // A caller-supplied cap object is the one place another tenant's plan limit
  // could be applied here, so it is checked against this ingest's workspace.
  if (params.caps) assertIngestCapsFor(params.caps, workspaceId);
  const caps = params.caps ?? (await resolveIngestCaps(workspaceId));
  const { value: maxBundleBytes, boundBy } = caps.maxBundleBytes;
  if (bytes.length === 0) return { kind: "empty_bundle" };
  if (bytes.length > maxBundleBytes) {
    return { kind: "bundle_too_large", bytes: bytes.length, maxBundleBytes, boundBy };
  }

  // ── Extract (in memory), then hand the files to the document seam ─────────
  let extracted: ExtractedBundle;
  try {
    extracted = extractBundle(bytes, {
      maxDocBytes: caps.maxDocBytes,
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
    caps,
    files: extracted.files,
    ...(params.publish !== undefined ? { publish: params.publish } : {}),
    ...(params.archiveAbsent !== undefined ? { archiveAbsent: params.archiveAbsent } : {}),
    upstreamRejections: extracted.errors,
  });
  return outcome.kind === "ok" ? { ...outcome, format: extracted.format } : outcome;
}
