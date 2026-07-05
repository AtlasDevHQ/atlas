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
  PageLoadError,
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
      // The config case — prescribe the one-line source.config.ts fix.
      throw new ProcessedTextUnavailableError(page.path);
    }
    // Any other failure (a shim's HTTP fetch, a file read) is a LOAD error:
    // still fail-loud with the page named, but without misdiagnosing it as
    // the missing-config case.
    throw new PageLoadError(page.path, message, err);
  }
  if (typeof body !== "string") {
    throw new PageLoadError(page.path, 'getText("processed") returned a non-string');
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

/** One page's outcome — a doc or a counted skip, never neither/both. */
type PageOutcome =
  | { readonly kind: "skip"; readonly reason: keyof CollectResult["skipped"] }
  | { readonly kind: "doc"; readonly doc: CollectedDoc; readonly rename?: ReservedRename };

async function collectPage(
  page: FumadocsOkfPage,
  prefixSegments: readonly string[],
  options: CollectOptions,
): Promise<PageOutcome> {
  // Filters run BEFORE the body resolves — a skipped page must never cost a
  // twin fetch / file read (473 api-reference stubs are a directory listing,
  // not 473 reads), and a skipped page with a broken body must not fail the
  // build.
  if ((options.skipApiReference ?? true) && isApiReferencePage(page.path)) {
    return { kind: "skip", reason: "apiReference" };
  }
  if (options.filter && !(await options.filter(page))) {
    return { kind: "skip", reason: "filtered" };
  }

  let body = await processedBody(page);
  if (options.transform) {
    const transformed = await options.transform(body, page);
    if (transformed === null) return { kind: "skip", reason: "transformSkipped" };
    body = transformed;
  }
  if ((options.skipContentless ?? true) && isContentlessBody(body)) {
    return { kind: "skip", reason: "contentless" };
  }

  const derived = deriveArchivePath(page.path);
  const path = [...prefixSegments, derived.path].join("/");
  const content = renderOkfDocument(
    { title: page.data.title, description: page.data.description },
    tagsFor(page, options.tags),
    body,
  );
  return {
    kind: "doc",
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
 * {@link ProcessedTextUnavailableError} / {@link PageLoadError} /
 * {@link ArchivePathCollisionError} / `InvalidPagePathError` — a bundle is
 * either right or refused, never silently partial (skips are counted and
 * returned, not hidden).
 */
export async function collectFumadocsPages(
  source: FumadocsOkfSource,
  options: CollectOptions,
): Promise<CollectResult> {
  const prefixSegments = normalizePrefix(options.prefix);
  const pages = source.getPages();
  const outcomes: PageOutcome[] = new Array<PageOutcome>(pages.length);

  // Bounded-concurrency pool; outcomes land by index so ordering is stable.
  // A non-finite/sub-1 concurrency value clamps to the default rather than
  // producing zero workers (Array.from({length: NaN}) is empty).
  const requested = options.concurrency;
  const concurrency =
    typeof requested === "number" && Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : DEFAULT_CONCURRENCY;
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

  for (let i = 0; i < outcomes.length; i++) {
    const outcome: PageOutcome | undefined = outcomes[i];
    if (outcome === undefined) {
      // A hole here means the worker pool skipped an index — an internal bug
      // that must never read as a silently smaller bundle.
      throw new Error(
        `internal: page ${i} ("${pages[i]?.path}") produced no outcome — collect-pool index bug`,
      );
    }
    if (outcome.kind === "skip") {
      skipped[outcome.reason]++;
      continue;
    }
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
