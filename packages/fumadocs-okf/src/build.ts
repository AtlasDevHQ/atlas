/**
 * One-shot build: collect → validate against the ingest caps → pack.
 *
 * `validateIngestCaps` + `packOkfBundle` are exported separately so a
 * multi-section site (like the Atlas docs portal) can run several collects
 * with different prefixes and pack them as ONE archive — caps AND path
 * uniqueness are then validated once, over the merged document set, exactly
 * as the ingest seam will see it.
 */

import { collectFumadocsPages } from "./collect";
import { ArchivePathCollisionError, IngestCapExceededError } from "./errors";
import { createDeterministicTarGz } from "./tar";
import {
  DEFAULT_INGEST_CAPS,
  type BuildOptions,
  type BuildResult,
  type CollectedDoc,
  type CollectResult,
  type FumadocsOkfSource,
  type IngestCaps,
} from "./types";

/**
 * Generation-time mirror of the checks Atlas's ingest seam applies
 * (`ingestBundle` → doc count / per-doc bytes / decoded-total bytes).
 * Throws {@link IngestCapExceededError} with the actual numbers.
 */
export function validateIngestCaps(
  docs: readonly CollectedDoc[],
  caps: IngestCaps = DEFAULT_INGEST_CAPS,
): { totalDocBytes: number } {
  if (docs.length > caps.maxDocs) {
    throw new IngestCapExceededError({
      cap: "maxDocs",
      actual: docs.length,
      limit: caps.maxDocs,
    });
  }
  let totalDocBytes = 0;
  for (const doc of docs) {
    if (doc.bytes > caps.maxDocBytes) {
      throw new IngestCapExceededError({
        cap: "maxDocBytes",
        actual: doc.bytes,
        limit: caps.maxDocBytes,
        docPath: doc.path,
      });
    }
    totalDocBytes += doc.bytes;
  }
  if (totalDocBytes > caps.maxBundleBytes) {
    throw new IngestCapExceededError({
      cap: "maxBundleBytes",
      actual: totalDocBytes,
      limit: caps.maxBundleBytes,
      detail: "decoded document total (the ingest decompression guard sees this)",
    });
  }
  return { totalDocBytes };
}

/**
 * Pack collected documents into a deterministic `.tar.gz`, validating the
 * caps over the full set first (including the compressed-size cap the ingest
 * route applies to the raw upload body).
 *
 * This is ALSO where the path-uniqueness invariant is enforced over the
 * whole set: `collectFumadocsPages` catches collisions within one collect,
 * but merged multi-section sets (overlapping prefixes, the same collect
 * passed twice) would otherwise pack two tar entries at one path and let
 * the ingest upsert silently last-write-win. Every pack path goes through
 * here, so a bundle is either collision-free or refused.
 */
export function packOkfBundle(
  docs: readonly CollectedDoc[],
  caps: IngestCaps = DEFAULT_INGEST_CAPS,
): { bytes: Uint8Array; totalDocBytes: number } {
  const byPath = new Map<string, string>();
  for (const doc of docs) {
    const existing = byPath.get(doc.path);
    if (existing !== undefined) {
      throw new ArchivePathCollisionError(doc.path, existing, doc.sourcePath);
    }
    byPath.set(doc.path, doc.sourcePath);
  }
  const { totalDocBytes } = validateIngestCaps(docs, caps);
  const bytes = createDeterministicTarGz(docs);
  if (bytes.length > caps.maxBundleBytes) {
    throw new IngestCapExceededError({
      cap: "maxBundleBytes",
      actual: bytes.length,
      limit: caps.maxBundleBytes,
      detail: "compressed archive size (the ingest route caps the raw upload body)",
    });
  }
  return { bytes, totalDocBytes };
}

/**
 * Merge per-collect results for multi-section packing (portal dogfood path).
 * Merging itself does not re-check path collisions across collects —
 * `packOkfBundle` does, so a cross-section duplicate is refused at pack.
 */
export function mergeCollectResults(results: readonly CollectResult[]): CollectResult {
  return {
    docs: results.flatMap((r) => r.docs),
    skipped: {
      filtered: results.reduce((n, r) => n + r.skipped.filtered, 0),
      apiReference: results.reduce((n, r) => n + r.skipped.apiReference, 0),
      contentless: results.reduce((n, r) => n + r.skipped.contentless, 0),
      transformSkipped: results.reduce((n, r) => n + r.skipped.transformSkipped, 0),
    },
    renamedReserved: results.flatMap((r) => r.renamedReserved),
  };
}

/**
 * Turn a Fumadocs source into an OKF `.tar.gz` bundle for the Atlas KB
 * bundle-sync connector (or the upload-ingest route) — collect, validate
 * against the ingest caps, pack.
 */
export async function buildFumadocsOkfBundle(
  source: FumadocsOkfSource,
  options: BuildOptions,
): Promise<BuildResult> {
  const collected = await collectFumadocsPages(source, options);
  const caps: IngestCaps = { ...DEFAULT_INGEST_CAPS, ...options.caps };
  const { bytes, totalDocBytes } = packOkfBundle(collected.docs, caps);
  return {
    bytes,
    docs: collected.docs,
    stats: {
      documents: collected.docs.length,
      totalDocBytes,
      archiveBytes: bytes.length,
      skipped: collected.skipped,
      renamedReserved: collected.renamedReserved,
    },
  };
}
