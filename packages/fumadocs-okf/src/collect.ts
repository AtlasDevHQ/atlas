/**
 * Map the Fumadocs loader surface onto `@atlas/okf-bundle`'s doc-source seam
 * — the whole of what this adapter IS after #4373.
 *
 * What stays here is exactly what is Fumadocs: resolving a page body via
 * `getText("processed")` (fail-loud when unavailable, never a raw-MDX
 * fallback), telling the missing-`includeProcessedMarkdown` config case apart
 * from a generic load failure, the default top-level `api-reference/` stub
 * skip, and wrapping the Fumadocs page shape (`data.*`) onto the seam.
 * Collection, path derivation, caps, collisions, and packing are the core's.
 */

import {
  collectPages,
  firstPathSegment,
  PageLoadError,
  type CollectOptions as CoreCollectOptions,
  type CollectResult,
  type DocSource,
  type DocSourcePage,
} from "@atlas/okf-bundle";

import { ProcessedTextUnavailableError } from "./errors";
import type { CollectOptions, FumadocsOkfPage, FumadocsOkfSource } from "./types";

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

/** First path segment of a normalized page path, lower-cased ("" when
 *  invalid) — the core's shared mechanics (`firstPathSegment`), re-exported
 *  under the adapter's historical name so both consumers of the
 *  `api-reference` rule read one implementation. */
export const firstSegment = firstPathSegment;

/**
 * True for auto-generated API-reference stub pages (`api-reference/…`) — the
 * adapter's built-in stub predicate behind `skipApiReference`.
 */
export function isApiReferencePage(pagePath: string): boolean {
  return firstSegment(pagePath) === "api-reference";
}

/** A doc-source page wrapping one Fumadocs page (hooks unwrap `.page`). */
interface FumadocsDocPage extends DocSourcePage {
  readonly page: FumadocsOkfPage;
}

function toDocPage(page: FumadocsOkfPage): FumadocsDocPage {
  return {
    page,
    path: page.path,
    url: page.url,
    // Metadata stays LAZY, mirroring the loader surface: a structural shim
    // may back `data.title` with a getter that reads/parses the file (the
    // docs portal does exactly that), and the core only touches these after
    // a page survives the filters — an eager read here would cost the 473
    // skipped api-reference stubs a file read each.
    get title() {
      return page.data.title;
    },
    get description() {
      return page.data.description;
    },
    get tags() {
      return page.data.tags;
    },
    loadBody: () => processedBody(page),
  };
}

/**
 * Map a Fumadocs source + Fumadocs-typed options onto the core's doc-source
 * seam — the single bridge both `collectFumadocsPages` and
 * `buildFumadocsOkfBundle` go through, so the hook unwrapping and the
 * `skipApiReference` default cannot diverge between the two entries.
 */
export function bridgeFumadocsSource(
  source: FumadocsOkfSource,
  options: CollectOptions,
): { source: DocSource<FumadocsDocPage>; options: CoreCollectOptions<FumadocsDocPage> } {
  const { filter, transform, tags, skipApiReference, ...rest } = options;
  return {
    source: { getPages: () => source.getPages().map(toDocPage) },
    options: {
      ...rest,
      isApiReferenceStub:
        (skipApiReference ?? true) ? (p) => isApiReferencePage(p.page.path) : undefined,
      filter: filter && ((p) => filter(p.page)),
      transform: transform && ((body, p) => transform(body, p.page)),
      tags: typeof tags === "function" ? (p) => tags(p.page) : tags,
    },
  };
}

/**
 * Collect every eligible page of a Fumadocs source into OKF documents via
 * the core pipeline. Throws {@link ProcessedTextUnavailableError} and the
 * core's `PageLoadError` / `ArchivePathCollisionError` /
 * `InvalidPagePathError` — a bundle is either right or refused, never
 * silently partial (skips are counted and returned, not hidden).
 */
export async function collectFumadocsPages(
  source: FumadocsOkfSource,
  options: CollectOptions,
): Promise<CollectResult> {
  const bridged = bridgeFumadocsSource(source, options);
  return collectPages(bridged.source, bridged.options);
}
