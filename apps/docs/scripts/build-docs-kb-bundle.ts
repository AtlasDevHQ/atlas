/**
 * Build a Knowledge Base ingest bundle from the docs portal content — the
 * dogfood consumer of the `@atlas/fumadocs-okf` adapter (issue #4367; the
 * #4366 spike, refit). The adapter owns everything bundle-shaped: OKF
 * rendering, deterministic archive paths (including the reserved-basename
 * fold that used to silently drop every `index.md` section landing at
 * ingest), generation-time ingest-cap validation, and the deterministic
 * `.tar.gz` packing. This script only supplies the portal-specific parts:
 *
 *   - the two source shims (`kb-bundle-sources.ts`) — the local `content/`
 *     walk and the deployed `llms.txt` + `.mdx`-twin fetch — because the
 *     portal's real Fumadocs loader lives behind the Next bundler;
 *   - the leak-safety-critical audience transform, passed through the
 *     adapter's body-transform hook: a SaaS bundle is structurally incapable
 *     of carrying self-hosted branches (`stripInactiveAudienceBlocks` fails
 *     closed; an unresolved page is skipped, never emitted).
 *
 *   bun run scripts/build-docs-kb-bundle.ts                       # SaaS bundle
 *   bun run scripts/build-docs-kb-bundle.ts --audience self-hosted
 *   bun run scripts/build-docs-kb-bundle.ts --out /tmp/kb.tar.gz --include-api-reference
 *   bun run scripts/build-docs-kb-bundle.ts --from-deployed https://docs.useatlas.dev
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildFumadocsOkfBundle,
  collectFumadocsPages,
  mergeCollectResults,
  packOkfBundle,
  type BuildResult,
  type CollectResult,
} from "@atlas/fumadocs-okf";
import type { Audience } from "../src/lib/audience";
import {
  deployedSource,
  localSectionSource,
  parseLlmsIndex,
  portalSectionCollectOptions,
  sectionsFor,
} from "./kb-bundle-sources";

const DOCS_ROOT = join(import.meta.dir, "..");
const CONTENT_DIR = join(DOCS_ROOT, "content");

/** Stable top-level prefix for deployed-mode bundles (local mode prefixes per section). */
const DEPLOYED_PREFIX = "portal";

interface Args {
  audience: Audience;
  out: string;
  includeApiReference: boolean;
  /** When set, build from a DEPLOYED docs site's `llms.txt` + `.mdx` twins over
   * HTTP instead of the local `content/` tree — no build, bodies byte-faithful
   * to `getText("processed")`. Value is the site base URL. */
  fromDeployed?: string;
}

function parseArgs(argv: string[]): Args {
  let audience: Audience = "saas";
  let out = join(process.cwd(), "docs-kb-bundle.tar.gz");
  let includeApiReference = false;
  let fromDeployed: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audience") {
      const v = argv[++i];
      if (v !== "saas" && v !== "self-hosted") {
        throw new Error(`--audience must be "saas" or "self-hosted", got "${v}"`);
      }
      audience = v;
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out needs a file path");
      out = v;
    } else if (a === "--include-api-reference") {
      includeApiReference = true;
    } else if (a === "--from-deployed") {
      const v = argv[++i];
      if (!v || !/^https?:\/\//.test(v)) {
        throw new Error(`--from-deployed needs an http(s) base URL, got "${v}"`);
      }
      fromDeployed = v.replace(/\/$/, "");
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { audience, out, includeApiReference, fromDeployed };
}

/** LOCAL mode: one adapter collect per section (prefix = section name), packed
 * as ONE archive so the caps + cross-section path uniqueness are validated
 * over the merged set. Every section's options come from
 * `portalSectionCollectOptions`, so the audience transform cannot be
 * forgotten for one section. */
async function buildLocal(args: Args): Promise<BuildResult> {
  const collects: CollectResult[] = [];
  for (const section of sectionsFor(args.audience)) {
    const source = await localSectionSource(join(CONTENT_DIR, section));
    collects.push(
      await collectFumadocsPages(
        source,
        portalSectionCollectOptions(section, args.audience, {
          includeApiReference: args.includeApiReference,
        }),
      ),
    );
  }
  const merged = mergeCollectResults(collects);
  const { bytes, totalDocBytes } = packOkfBundle(merged.docs);
  return {
    bytes,
    docs: merged.docs,
    stats: {
      documents: merged.docs.length,
      totalDocBytes,
      archiveBytes: bytes.length,
      skipped: merged.skipped,
      renamedReserved: merged.renamedReserved,
    },
  };
}

/** DEPLOYED mode: pages from the site's `llms.txt`, bodies from the `.mdx`
 * twins (already audience-resolved — no transform). A twin fetch failure is
 * FAIL-LOUD (unlike the #4366 spike's warn-and-skip): a silently partial
 * bundle fed to a bundle-sync collection would ARCHIVE the missing pages'
 * previously-reviewed documents via the subtractive diff. */
async function buildDeployed(args: Args, base: string): Promise<BuildResult> {
  const indexPath = args.audience === "saas" ? "/llms.txt" : "/self-hosted/llms.txt";
  const indexUrl = `${base}${indexPath}`;

  const res = await fetch(indexUrl);
  if (!res.ok) {
    throw new Error(`Fetch ${indexUrl} → ${res.status} ${res.statusText}`);
  }
  const entries = parseLlmsIndex(await res.text()).filter(
    // The bare site root ("/") is skipped as in #4366: its twin URL shape is
    // not a page twin, so deployed-mode bundles simply do not include the
    // site-root landing page (local mode does, as <section>/overview.md).
    (entry) => entry.path !== "/" && entry.path !== indexPath,
  );
  if (entries.length === 0) throw new Error(`No pages parsed from ${indexUrl}`);

  return buildFumadocsOkfBundle(deployedSource(base, entries), {
    prefix: DEPLOYED_PREFIX,
    tags: ["docs-portal", "deployed"],
    skipApiReference: !args.includeApiReference,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const result = args.fromDeployed
    ? await buildDeployed(args, args.fromDeployed)
    : await buildLocal(args);

  if (result.stats.documents === 0) {
    throw new Error("No documents collected — nothing to bundle.");
  }

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, result.bytes);

  const { stats } = result;
  console.log("");
  console.log(`Bundle:    ${args.out}`);
  console.log(
    args.fromDeployed
      ? `Source:    ${args.fromDeployed}  (deployed llms.txt + .mdx twins, ${args.audience})`
      : `Source:    local content/  (${args.audience}: ${sectionsFor(args.audience).join(", ")})`,
  );
  console.log(`Documents: ${stats.documents}  (expect the SAME count ingested — a smaller`);
  console.log(`           ingest count means silent drops; investigate, don't shrug)`);
  console.log(`Size:      ${(stats.archiveBytes / 1_000_000).toFixed(2)} MB compressed, ${(stats.totalDocBytes / 1_000_000).toFixed(2)} MB decoded`);
  if (stats.skipped.apiReference > 0) console.log(`Skipped:   ${stats.skipped.apiReference} api-reference stubs`);
  if (stats.skipped.contentless > 0) console.log(`Skipped:   ${stats.skipped.contentless} contentless (component-only) pages`);
  if (stats.skipped.transformSkipped > 0) console.log(`Skipped:   ${stats.skipped.transformSkipped} pages (audience strip — see warnings above)`);
  if (stats.renamedReserved.length > 0) {
    console.log(`Renamed:   ${stats.renamedReserved.length} reserved-basename pages (index/log → ingestable paths):`);
    for (const r of stats.renamedReserved) console.log(`             ${r.from} → ${r.to}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
