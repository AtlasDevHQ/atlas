/**
 * One-shot Fumadocs build — the adapter's convenience entry over the core's
 * collect → validate → pack pipeline. Multi-section sites collect per section
 * with `collectFumadocsPages` and pack ONCE via the core's
 * `mergeCollectResults` + `packOkfBundle`, so caps and path uniqueness are
 * validated over the merged set exactly as the ingest seam will see it.
 */

import {
  DEFAULT_INGEST_CAPS,
  packOkfBundle,
  type BuildResult,
  type IngestCaps,
} from "@atlas/okf-bundle";

import { collectFumadocsPages } from "./collect";
import type { BuildOptions, FumadocsOkfSource } from "./types";

/**
 * Turn a Fumadocs source into an OKF `.tar.gz` bundle for the Atlas KB
 * bundle-sync connector (or the upload-ingest route) — collect, validate
 * against the ingest caps, pack.
 */
export async function buildFumadocsOkfBundle(
  source: FumadocsOkfSource,
  options: BuildOptions,
): Promise<BuildResult> {
  const { caps: capOverrides, ...collectOptions } = options;
  const collected = await collectFumadocsPages(source, collectOptions);
  const caps: IngestCaps = { ...DEFAULT_INGEST_CAPS, ...capOverrides };
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
