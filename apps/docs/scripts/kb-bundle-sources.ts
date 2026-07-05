/**
 * Source-like shims feeding the `@atlas/fumadocs-okf` adapter from the docs
 * portal — the dogfood refit of #4366's throwaway builder (issue #4367).
 *
 * Why shims instead of the real `src/lib/source.ts` loaders: the generated
 * `.source/server.ts` imports `*.mdx?collection=…` modules only the Next
 * bundler can resolve, so a plain `bun run scripts/…` CLI cannot load the
 * portal's actual Fumadocs source (see `src/lib/compose.ts`). These shims
 * implement the adapter's structural loader contract instead:
 *
 *   - {@link localSectionSource} — walk one `content/<section>` tree;
 *     `getText("processed")` returns the fence-aware ESM-strip APPROXIMATION
 *     of fumadocs' processed markdown (same fidelity note as #4366). An
 *     in-Next consumer would pass the real loader and get byte-faithful
 *     bodies — the approximation lives HERE, not in the adapter.
 *   - {@link deployedSource} — read a deployed site's `llms.txt` index and
 *     serve each page's `.mdx` twin as its processed text (byte-faithful,
 *     already audience-resolved by `getLLMText`; no transform needed).
 *
 * The leak-safety-critical transform — resolving `<WhenSaaS>` /
 * `<WhenSelfHosted>` / `<AudienceLink>` for the target audience — rides the
 * adapter's body-transform hook ({@link portalAudienceTransform}), importing
 * the portal's OWN `stripInactiveAudienceBlocks` (the function `getLLMText`
 * uses). Its fail-closed residual-tag check means a page that cannot be
 * fully resolved is SKIPPED (transform → null), never emitted with the other
 * audience's branch — so a SaaS bundle remains structurally incapable of
 * carrying self-hosted content.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import type { FumadocsOkfPage, FumadocsOkfSource } from "@atlas/fumadocs-okf";
import { stripInactiveAudienceBlocks } from "../src/lib/audience-markdown";
import type { Audience } from "../src/lib/audience";

// ---------------------------------------------------------------------------
// Shared frontmatter/body helpers (ported from the #4366 builder)
// ---------------------------------------------------------------------------

export interface PortalFrontmatter {
  title?: string;
  description?: string;
  tags?: string[];
}

/**
 * Split leading `---\n…\n---` frontmatter from the body and pull the scalar
 * fields we mirror into OKF. Deliberately minimal — the docs frontmatter is
 * clean (`title`/`description`, occasionally `audience`/`fork`/`tags`), so a
 * line-scan for top-level scalars beats pulling in a YAML dependency. Unparsed
 * fields are simply ignored; a missing title falls back to the first `# heading`
 * or the filename downstream (matching the ingest seam's own lenient behaviour).
 */
export function splitFrontmatter(raw: string): { fm: PortalFrontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const body = raw.slice(m[0].length);
  const fm: PortalFrontmatter = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rawVal = kv[2].trim();
    if (key === "title" || key === "description") {
      fm[key] = unquote(rawVal);
    } else if (key === "tags") {
      fm.tags = parseTags(rawVal, lines, i);
    }
  }
  return { fm, body };
}

function unquote(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Handle both flow (`[a, b]`) and block (`\n  - a\n  - b`) YAML tag lists. */
function parseTags(inline: string, lines: string[], idx: number): string[] {
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((t) => unquote(t.trim()))
      .filter(Boolean);
  }
  const tags: string[] = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const item = /^\s*-\s*(.+)$/.exec(lines[j]);
    if (!item) break;
    tags.push(unquote(item[1].trim()));
  }
  return tags;
}

/**
 * Drop MDX module syntax (top-level `import …` / `export …`) so the body reads
 * as prose — mirroring what fumadocs' `getText("processed")` removes. Must be
 * FENCE-AWARE: `import`/`export` lines inside a ``` code block are code
 * *examples* (e.g. the SDK reference's `import type { AtlasClient } …`), not
 * module syntax — stripping them corrupts the example, and a multi-line one
 * would leave a dangling `} from "…"`. So only column-0 ESM statements OUTSIDE a
 * fence are removed, consuming continuation lines of a multi-line statement.
 */
export function stripMdxModuleLines(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let fence: string | null = null; // the opening fence's marker while open

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0].repeat(3); // open (track char)
      else if (marker.startsWith(fence)) fence = null; // close on same char
      out.push(line);
      continue;
    }
    // A real MDX ESM statement is at column 0 and outside any fence.
    if (fence === null && /^(import|export)\s/.test(line)) {
      // Consume continuation lines ONLY when the line clearly opens a multi-line
      // construct (trailing `{`/`(`/`[`/`,`) — so a single-line `export default
      // Foo` with no terminator can never run the scan away into the prose that
      // follows. The corpus has no top-level multi-line ESM today (all such
      // statements live inside fences, handled above); this stays correct if one
      // is added later.
      if (/[{([,]\s*$/.test(line)) {
        i++;
        while (i < lines.length && !/([)}\]]|["'`]|;)\s*;?\s*$/.test(lines[i])) i++;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "");
}

// ---------------------------------------------------------------------------
// Audience transform hook (leak-safety critical)
// ---------------------------------------------------------------------------

/**
 * The adapter body-transform resolving audience conditionals for one mount.
 * Fail-SOFT per page, fail-CLOSED per body: `stripInactiveAudienceBlocks`
 * throws when any raw audience construct survives, and this hook maps that
 * throw to `null` (skip the page, count it, log it) — the page is dropped
 * from the bundle rather than ever emitted with an unresolved branch.
 */
export function portalAudienceTransform(
  audience: Audience,
  onSkip?: (pagePath: string, reason: string) => void,
): (body: string, page: FumadocsOkfPage) => string | null {
  return (body, page) => {
    try {
      return stripInactiveAudienceBlocks(body, audience);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSkip?.(page.path, msg);
      return null;
    }
  };
}

/** The content collections composing each audience's surface (mirrors
 * `buildSectionSource` in `src/lib/source.ts`). `shared` is mounted into both. */
export function sectionsFor(audience: Audience): string[] {
  return audience === "saas" ? ["docs", "shared"] : ["self-hosted", "shared"];
}

// ---------------------------------------------------------------------------
// LOCAL mode shim — walk one content/<section> tree
// ---------------------------------------------------------------------------

/**
 * Build a source-like over `content/<section>`: one page per `.mdx` file,
 * frontmatter mirrored into `data`, `getText("processed")` returning the
 * ESM-strip approximation. Page paths are section-relative — pass the section
 * name as the adapter's `prefix` so archive paths come out `docs/…`,
 * `shared/…`, `self-hosted/…`.
 */
export async function localSectionSource(sectionDir: string): Promise<FumadocsOkfSource> {
  const glob = new Glob("**/*.mdx");
  const relPaths: string[] = [];
  for await (const rel of glob.scan(sectionDir)) relPaths.push(rel);
  relPaths.sort();

  const pages: FumadocsOkfPage[] = relPaths.map((rel) => ({
    path: rel,
    data: {
      // Frontmatter + body resolve lazily per hit, so a filtered page (e.g.
      // the 473 api-reference stubs) costs a directory entry, not a read.
      get title(): string | undefined {
        return readSplit(sectionDir, rel).fm.title;
      },
      get description(): string | undefined {
        return readSplit(sectionDir, rel).fm.description;
      },
      get tags(): string[] | undefined {
        return readSplit(sectionDir, rel).fm.tags;
      },
      getText: async () => stripMdxModuleLines(readSplit(sectionDir, rel).body),
    },
  }));
  return { getPages: () => pages };
}

/** Per-file cache so title/description/tags/getText share one read+parse. */
const splitCache = new Map<string, { fm: PortalFrontmatter; body: string }>();

function readSplit(sectionDir: string, rel: string): { fm: PortalFrontmatter; body: string } {
  const key = join(sectionDir, rel);
  const cached = splitCache.get(key);
  if (cached) return cached;
  const raw = readFileSync(key, "utf8");
  const split = splitFrontmatter(raw);
  splitCache.set(key, split);
  return split;
}

// ---------------------------------------------------------------------------
// DEPLOYED mode shim — llms.txt index + per-page .mdx twins over HTTP
// ---------------------------------------------------------------------------

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
 * Map a deployed URL path onto a synthetic `page.path` for the adapter. A
 * section-landing path (trailing slash) becomes `<section>/index.mdx`, which
 * the adapter FOLDS onto the section slug — closing the reserved-basename
 * drop the #4366 spike's `deployedOutRel` (`…/index.md`) walked into.
 */
export function deployedPagePath(urlPath: string): string {
  return `${urlPath.replace(/^\//, "").replace(/\/$/, "/index")}.mdx`;
}

/**
 * Build a source-like over a DEPLOYED docs site: pages from the `llms.txt`
 * index, bodies fetched lazily from each page's `.mdx` twin (byte-faithful to
 * `getText("processed")`, already audience-resolved — no transform needed).
 * A twin fetch failure throws with the page named; the adapter surfaces it
 * (fail-loud) rather than emitting a partial bundle silently.
 */
export function deployedSource(base: string, entries: readonly DeployedIndexEntry[]): FumadocsOkfSource {
  const pages: FumadocsOkfPage[] = entries.map((entry) => ({
    path: deployedPagePath(entry.path),
    url: entry.path,
    data: {
      title: entry.title,
      description: entry.description,
      getText: async () => {
        const twinUrl = `${base}${entry.path}.mdx`;
        const res = await fetch(twinUrl);
        if (!res.ok) {
          throw new Error(`Fetch ${twinUrl} → ${res.status} ${res.statusText}`);
        }
        return stripTwinHeading(await res.text());
      },
    },
  }));
  return { getPages: () => pages };
}
