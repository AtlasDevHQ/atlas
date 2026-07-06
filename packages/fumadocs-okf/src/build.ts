/**
 * One-shot Fumadocs build — the adapter's convenience entry, delegated to
 * the core's `buildOkfBundle` through the same bridge `collectFumadocsPages`
 * uses (no adapter-side re-assembly of caps or stats — one home for that
 * wiring). Multi-section sites collect per section with
 * `collectFumadocsPages` and pack ONCE via the core's `mergeCollectResults`
 * + `packOkfBundle`, so caps and path uniqueness are validated over the
 * merged set exactly as the ingest seam will see it.
 */

import { buildOkfBundle, type BuildResult } from "@atlas/okf-bundle";

import { bridgeFumadocsSource } from "./collect";
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
  const { caps, ...collectOptions } = options;
  const bridged = bridgeFumadocsSource(source, collectOptions);
  return buildOkfBundle(bridged.source, { ...bridged.options, caps });
}
