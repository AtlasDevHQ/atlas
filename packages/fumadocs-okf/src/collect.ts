/**
 * Walk a Fumadocs source and collect OKF documents — the adapter's core.
 *
 * Per page: filter hooks (built-in + caller) → `getText("processed")`
 * (fail-loud when unavailable, never a raw-MDX fallback) → body-transform
 * hook → contentless check → OKF render → deterministic archive path.
 * Bodies resolve under bounded concurrency (a shim's `getText` may be an
 * HTTP fetch), but the result is ordered by the source's page order and the
 * packer sorts by path, so output never depends on completion timing.
 */

import {
  ArchivePathCollisionError,
  ProcessedTextUnavailableError,
} from "./errors";
import { isContentlessBody, pageTags, renderOkfDocument } from "./okf";
import { deriveArchivePath, isApiReferencePage, normalizePrefix } from "./paths";
import type {
  CollectedDoc,
  CollectOptions,
  CollectResult,
  FumadocsOkfPage,
  FumadocsOkfSource,
  ReservedRename,
} from "./types";

const DEFAULT_CONCURRENCY = 8;

/** fumadocs-mdx's own error message when `includeProcessedMarkdown` is off. */
const FUMADOCS_MISSING_PROCESSED = /includeProcessedMarkdown/;

async function processedBody(page: FumadocsOkfPage): Promise<string> {
  const getText = page.data.getText;
  if (typeof getText !== "function") {
    throw new ProcessedTextUnavailableError(page.path, "page.data.getText is not available");
  }
  let body: unknown;
  try {
    body = await getText("processed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (FUMADOCS_MISSING_PROCESSED.test(message)) {
      throw new ProcessedTextUnavailableError(page.path);
    }
    // Any other load failure still fails the build — with the page named.
    throw new ProcessedTextUnavailableError(page.path, message);
  }
  if (typeof body !== "string") {
    throw new ProcessedTextUnavailableError(page.path, "getText(\"processed\") returned a non-string");
  }
  return body;
}

function tagsFor(
  page: FumadocsOkfPage,
  option: CollectOptions["tags"],
): string[] {
  const configured = typeof option === "function" ? option(page) : (option ?? []);
  return [...new Set([...configured, ...pageTags(page.data.tags)])];
}

interface PageOutcome {
  readonly doc?: CollectedDoc;
  readonly rename?: ReservedRename;
  readonly skip?: "filtered" | "apiReference" | "contentless" | "transformSkipped";
}

async function collectPage(
  page: FumadocsOkfPage,
  prefixSegments: readonly string[],
  options: CollectOptions,
): Promise<PageOutcome> {
  if ((options.skipApiReference ?? true) && isApiReferencePage(page.path)) {
    return { skip: "apiReference" };
  }
  if (options.filter && !(await options.filter(page))) {
    return { skip: "filtered" };
  }

  let body = await processedBody(page);
  if (options.transform) {
    const transformed = await options.transform(body, page);
    if (transformed === null) return { skip: "transformSkipped" };
    body = transformed;
  }
  if ((options.skipContentless ?? true) && isContentlessBody(body)) {
    return { skip: "contentless" };
  }

  const derived = deriveArchivePath(page.path);
  const path = [...prefixSegments, derived.path].join("/");
  const content = renderOkfDocument(
    { title: page.data.title, description: page.data.description },
    tagsFor(page, options.tags),
    body,
  );
  return {
    doc: {
      path,
      content,
      bytes: new TextEncoder().encode(content).length,
      sourcePath: page.path,
    },
    rename: derived.renamedFromReserved ? { from: page.path, to: path } : undefined,
  };
}

/**
 * Collect every eligible page of a source into OKF documents. Throws
 * {@link ProcessedTextUnavailableError} / {@link ArchivePathCollisionError} /
 * `InvalidPagePathError` — a bundle is either right or refused, never
 * silently partial (skips are counted and returned, not hidden).
 */
export async function collectFumadocsPages(
  source: FumadocsOkfSource,
  options: CollectOptions,
): Promise<CollectResult> {
  const prefixSegments = normalizePrefix(options.prefix);
  const pages = source.getPages();
  const outcomes: PageOutcome[] = new Array<PageOutcome>(pages.length);

  // Bounded-concurrency pool; outcomes land by index so ordering is stable.
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let i = cursor++; i < pages.length; i = cursor++) {
      outcomes[i] = await collectPage(pages[i], prefixSegments, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length || 1) }, worker));

  const docs: CollectedDoc[] = [];
  const renamedReserved: ReservedRename[] = [];
  const skipped = { filtered: 0, apiReference: 0, contentless: 0, transformSkipped: 0 };
  const byPath = new Map<string, string>();

  for (const outcome of outcomes) {
    if (outcome.skip) {
      skipped[outcome.skip]++;
      continue;
    }
    if (!outcome.doc) continue; // unreachable: every outcome is a skip or a doc
    const existing = byPath.get(outcome.doc.path);
    if (existing !== undefined) {
      throw new ArchivePathCollisionError(outcome.doc.path, existing, outcome.doc.sourcePath);
    }
    byPath.set(outcome.doc.path, outcome.doc.sourcePath);
    docs.push(outcome.doc);
    if (outcome.rename) renamedReserved.push(outcome.rename);
  }

  return { docs, skipped, renamedReserved };
}
