/**
 * Portal-policy sources feeding `@atlas/okf-bundle` from the docs portal —
 * what remains after the markdown-tree adapter promotion (#4374; the dogfood
 * refit history: #4366 spike → #4367 adapter → #4373 core split).
 *
 * Why sources instead of the real `src/lib/source.ts` loaders: the generated
 * `.source/server.ts` imports `*.mdx?collection=…` modules only the Next
 * bundler can resolve, so a plain `bun run scripts/…` CLI cannot load the
 * portal's actual Fumadocs source (see `src/lib/compose.ts`). Local mode is
 * therefore the core's own **markdown-tree adapter** over one
 * `content/<section>` tree ({@link portalLocalSource} — the ESM-strip
 * APPROXIMATION of fumadocs' processed markdown lives in that adapter; an
 * in-Next consumer would use `@atlas/fumadocs-okf` with the real loader and
 * get byte-faithful bodies).
 *
 * What is genuinely PORTAL policy — all that's left in this file:
 *
 *   - the audience transform ({@link portalAudienceTransform}) — the
 *     leak-safety-critical strip riding the core's body-transform hook;
 *   - the section/prefix list ({@link sectionsFor}) and per-section collect
 *     options ({@link portalSectionCollectOptions});
 *   - {@link deployedSource} — read a deployed site's `llms.txt` index and
 *     serve each page's `.mdx` twin as its body (byte-faithful, already
 *     audience-resolved by `getLLMText`; no transform needed). Stays
 *     portal-local: it depends on this site's hand-authored `llms.txt` route
 *     and `.mdx`-twin URL shape, which is not a generalizable docs surface.
 *
 * The audience transform resolves `<WhenSaaS>` / `<WhenSelfHosted>` /
 * `<AudienceLink>` for the target audience via the portal's OWN
 * `stripInactiveAudienceBlocks` (the function `getLLMText` uses). Its
 * fail-closed residual-tag check means a page that cannot be fully resolved
 * is SKIPPED (transform → null), never emitted with the other audience's
 * branch — so a SaaS bundle remains structurally incapable of carrying
 * self-hosted content.
 */

import { YAML } from "bun";
import {
  createMarkdownTreeSource,
  firstPathSegment,
  type CollectOptions,
  type DocSource,
  type DocSourcePage,
} from "@atlas/okf-bundle";
import {
  ResidualAudienceTagError,
  stripInactiveAudienceBlocks,
} from "../src/lib/audience-markdown";
import type { Audience } from "../src/lib/audience";

// ---------------------------------------------------------------------------
// Audience transform hook (leak-safety critical)
// ---------------------------------------------------------------------------

/**
 * The body-transform resolving audience conditionals for one mount.
 * Fail-SOFT per page, fail-CLOSED per body: `stripInactiveAudienceBlocks`
 * throws `ResidualAudienceTagError` when any raw audience construct survives,
 * and this hook maps EXACTLY that throw to `null` (skip the page, count it,
 * log it) — the page is dropped from the bundle rather than ever emitted
 * with an unresolved branch. Any OTHER throw is a bug in the strip itself
 * and is rethrown: a systemic failure must abort the build, not quietly thin
 * the bundle page by page (a thinner bundle fed to bundle-sync would archive
 * the missing pages' documents via the subtractive diff).
 */
export function portalAudienceTransform(
  audience: Audience,
  onSkip?: (pagePath: string, reason: string) => void,
): (body: string, page: { readonly path: string }) => string | null {
  const reportSkip =
    onSkip ??
    ((pagePath: string, reason: string) => {
      console.warn(`  skip (audience strip) ${pagePath}: ${reason}`);
    });
  return (body, page) => {
    try {
      return stripInactiveAudienceBlocks(body, audience);
    } catch (err) {
      if (!(err instanceof ResidualAudienceTagError)) throw err;
      reportSkip(page.path, err.message);
      return null;
    }
  };
}

/** The content collections composing each audience's surface — mirrors the
 * `buildSectionSource` (`src/lib/compose.ts`) compositions in
 * `src/lib/source.ts`. `shared` is mounted into both. */
export function sectionsFor(audience: Audience): string[] {
  return audience === "saas" ? ["docs", "shared"] : ["self-hosted", "shared"];
}

/** Auto-generated API-reference stub pages (`api-reference/…` under the docs
 *  section) — `<APIPage>` shells with no prose. The portal's predicate for
 *  the core's `isApiReferenceStub` hook (the core has no stub opinion of its
 *  own), built on the same shared segment mechanics (`firstPathSegment`) as
 *  the Fumadocs adapter's built-in default — one implementation, two
 *  policies that can't drift. */
export function isApiReferencePage(pagePath: string): boolean {
  return firstPathSegment(pagePath) === "api-reference";
}

/**
 * The core collect options every LOCAL-mode section collect uses — one
 * function so the audience transform cannot be forgotten for a section (the
 * leak-safety wiring is pinned by `src/lib/__tests__/kb-bundle.test.ts`
 * through here).
 */
export function portalSectionCollectOptions(
  section: string,
  audience: Audience,
  opts: { includeApiReference?: boolean; onSkip?: (pagePath: string, reason: string) => void } = {},
): CollectOptions {
  return {
    prefix: section,
    transform: portalAudienceTransform(audience, opts.onSkip),
    // Provenance tags make the bundle's origin legible in the review UI.
    tags: ["docs-portal", section],
    isApiReferenceStub: (opts.includeApiReference ?? false)
      ? undefined
      : (page) => isApiReferencePage(page.path),
  };
}

// ---------------------------------------------------------------------------
// LOCAL mode — the core's markdown-tree adapter over content/<section>
// ---------------------------------------------------------------------------

/**
 * One `content/<section>` tree as a doc source: the core's markdown-tree
 * adapter (sorted walk, wire-module frontmatter split, fence-aware ESM strip)
 * with Bun's YAML parser injected. Page paths are section-relative — pass the
 * section name as the collect `prefix` so archive paths come out `docs/…`,
 * `shared/…`, `self-hosted/…`.
 */
export function portalLocalSource(sectionDir: string): Promise<DocSource> {
  return createMarkdownTreeSource({ root: sectionDir, parseYaml: YAML.parse });
}

// ---------------------------------------------------------------------------
// DEPLOYED mode — llms.txt index + per-page .mdx twins over HTTP
// ---------------------------------------------------------------------------

/** Per-request timeout for deployed-mode HTTP fetches (index + twins) — a
 *  hung CDN edge must fail the build with the URL named, not stall it
 *  forever. Generous because a cold serverless docs deploy can be slow. */
export const DEPLOYED_FETCH_TIMEOUT_MS = 30_000;

/** `fetch` with {@link DEPLOYED_FETCH_TIMEOUT_MS}, every failure path renamed
 *  to a message carrying the URL — the runtime's own errors ("fetch failed",
 *  an `AbortSignal.timeout` DOMException) name neither the URL nor the
 *  timeout, and with hundreds of twin fetches resolving under the collect
 *  pool's concurrency, "which page's twin died" must never be a mystery. */
export async function fetchWithTimeout(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(DEPLOYED_FETCH_TIMEOUT_MS) });
  } catch (err) {
    const detail =
      err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `timed out after ${DEPLOYED_FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`Fetch ${url} failed: ${detail}`, { cause: err });
  }
}

export interface DeployedIndexEntry {
  title: string;
  path: string;
  description?: string;
}

/**
 * Parse a deployed `llms.txt` index (`- [Title](url): description` lines) into
 * page entries. Reads each link's URL PATH — not the host — because the index
 * absolutizes every URL to the hardcoded `docs.useatlas.dev` regardless of which
 * deployment served it, so we re-root the path onto the deployed base.
 */
export function parseLlmsIndex(indexText: string): DeployedIndexEntry[] {
  const out: DeployedIndexEntry[] = [];
  for (const line of indexText.split("\n")) {
    const m = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?::\s*(.*\S))?\s*$/.exec(line);
    if (!m) continue;
    const [, title, url, description] = m;
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      // intentionally ignored: not an absolute URL — treat it as a
      // site-relative path; a garbage path fails loud at the twin fetch.
      path = url.startsWith("/") ? url : `/${url}`;
    }
    out.push({ title: title.trim(), path, description: description?.trim() || undefined });
  }
  return out;
}

/** `getLLMText` prepends `# Title (url)` to every twin; drop that leading H1
 * (the title goes into OKF frontmatter) so the body starts at real content. */
export function stripTwinHeading(body: string): string {
  return body.replace(/^#\s+.*(?:\r?\n)+/, "");
}

/**
 * Map a deployed URL path onto a synthetic `page.path` for the bundle
 * builder. A section-landing path (trailing slash) becomes
 * `<section>/index.mdx`, which the builder FOLDS onto the section slug —
 * closing the reserved-basename drop the #4366 spike's `deployedOutRel`
 * (`…/index.md`) walked into.
 */
export function deployedPagePath(urlPath: string): string {
  return `${urlPath.replace(/^\//, "").replace(/\/$/, "/index")}.mdx`;
}

/**
 * Build a doc source over a DEPLOYED docs site: pages from the `llms.txt`
 * index, bodies fetched lazily from each page's `.mdx` twin (byte-faithful to
 * `getText("processed")`, already audience-resolved — no transform needed).
 * A twin fetch failure (or timeout) throws with the URL named; the collect
 * stage surfaces it (fail-loud) rather than emitting a partial bundle
 * silently.
 */
export function deployedSource(
  base: string,
  entries: readonly DeployedIndexEntry[],
): DocSource {
  const pages: DocSourcePage[] = entries.map((entry) => ({
    path: deployedPagePath(entry.path),
    url: entry.path,
    title: entry.title,
    description: entry.description,
    loadBody: async () => {
      const twinUrl = `${base}${entry.path}.mdx`;
      const res = await fetchWithTimeout(twinUrl);
      if (!res.ok) {
        throw new Error(`Fetch ${twinUrl} → ${res.status} ${res.statusText}`);
      }
      return stripTwinHeading(await res.text());
    },
  }));
  return { getPages: () => pages };
}
