/**
 * The markdown-tree doc-source adapter — the second NAMED adapter at the
 * doc-source seam (#4374, PRD #4372), and the one every file-based docs
 * source needs: walk a tree of `.md`/`.mdx` files, split frontmatter via the
 * wire module's shared mechanics, optionally strip MDX module lines
 * fence-aware. "Any docs folder" works out of the box; the Mintlify importer
 * (`createMintlifySource` in `./mintlify`, #4391) is this adapter plus a
 * `docs.json` nav filter.
 *
 * Promoted from the docs portal's `localSectionSource` shim (issue #4374):
 * the portal keeps only portal policy (audience transform, section list);
 * the walk, the frontmatter split, and the ESM strip live here for every
 * consumer.
 *
 * YAML parsing is INJECTED ({@link ParseYaml}), exactly like the wire
 * module's `splitFrontmatterBlock` — this package's runtime dependency set
 * stays `fflate`-only. Pass `js-yaml`'s `load`, `Bun.YAML.parse`, or any
 * parser of your choice.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { PageLoadError } from "./errors";
import type { DocSource, DocSourcePage } from "./types";
import { splitFrontmatterBlock, type ParseYaml } from "./wire";

/** Frontmatter fields the adapter mirrors onto the doc-source page. */
interface TreePageMeta {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: unknown;
}

interface TreeEntry {
  readonly meta: TreePageMeta;
  readonly body: string;
}

export interface MarkdownTreeSourceOptions {
  /** Directory to walk. Page paths (and archive paths) are relative to it. */
  readonly root: string;
  /**
   * YAML document parser for the frontmatter split — injected so this
   * package adds no YAML dependency (runtime deps stay `fflate`-only; e.g.
   * pass `js-yaml`'s `load` or `Bun.YAML.parse`).
   */
  readonly parseYaml: ParseYaml;
  /**
   * Page file extensions to include. Default `[".md", ".mdx"]`. Matched
   * case-insensitively against the filename's end.
   */
  readonly extensions?: readonly string[];
  /**
   * Strip top-level MDX module lines (`import …` / `export …`) from `.mdx`
   * bodies, fence-aware, so the body reads as prose — mirroring what
   * fumadocs' `getText("processed")` removes. Default `true`; applies to
   * `.mdx` pages only (a `.md` file has no MDX module syntax, and prose
   * legitimately starting with "import " must survive). See
   * {@link stripMdxModuleLines}.
   */
  readonly stripMdxModules?: boolean;
}

/** Default page extensions — shared with the Mintlify importer so its nav
 *  filter strips the same set the walk enumerates. */
export const DEFAULT_EXTENSIONS = [".md", ".mdx"] as const;

/** Longest multi-line ESM statement the strip will consume before deciding
 *  the "statement" is really prose (a hard-wrapped paragraph whose wrap put
 *  `import `/`export ` at column 0). A real specifier list is a handful of
 *  lines; prose runs long. */
const MAX_ESM_CONTINUATION_LINES = 24;

const CLOSING_BRACKETS = ")]}";
const TERMINATOR_TAILS = `)]}"'\`;`;

/**
 * A line that MIGHT end a multi-line ESM statement (bracket/quote/semicolon
 * tail, optionally followed by one `;`). Deliberately loose — every candidate
 * is then validated by {@link isEsmCloserLine} so prose that merely ends in
 * `)` can't quietly terminate (and truncate) the scan. String ops instead of
 * a regex: the tail pattern's adjacent optional-whitespace runs backtrack
 * polynomially on hostile whitespace, and this runs on library-supplied page
 * bodies (CodeQL js/polynomial-redos — same posture as the wire module's
 * `topLevelHeading`).
 */
function isEsmTerminatorCandidate(line: string): boolean {
  let s = line.trimEnd();
  if (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
  return s !== "" && TERMINATOR_TAILS.includes(s.charAt(s.length - 1));
}

/**
 * A line that actually LOOKS like the end of an ESM statement: closing
 * brackets, an optional `from "specifier"` tail, an optional semicolon —
 * nothing else. `} from "pkg";`, `)`, `];` match; `see the survey (Fig 2)`
 * and `  title: "Hello"` do not. String ops, not a regex (see
 * {@link isEsmTerminatorCandidate}).
 */
function isEsmCloserLine(line: string): boolean {
  let s = line.trim();
  let brackets = 0;
  while (brackets < s.length && CLOSING_BRACKETS.includes(s.charAt(brackets))) brackets++;
  if (brackets === 0) return false;
  s = s.slice(brackets).trim();
  if (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
  if (s === "") return true;
  // Only a `from <quoted specifier>` tail may follow the brackets.
  if (!s.startsWith("from") || s.length < 5 || !/\s/.test(s.charAt(4))) return false;
  const spec = s.slice(5).trim();
  if (spec.length < 2) return false;
  const quote = spec.charAt(0);
  if (quote !== '"' && quote !== "'") return false;
  if (spec.charAt(spec.length - 1) !== quote) return false;
  return !spec.slice(1, -1).includes(quote);
}

/**
 * Drop MDX module syntax (top-level `import …` / `export …`) so the body reads
 * as prose. Must be FENCE-AWARE: `import`/`export` lines inside a ``` code
 * block are code *examples* (e.g. an SDK reference's `import type { … } from`),
 * not module syntax — stripping them corrupts the example, and a multi-line
 * one would leave a dangling `} from "…"`. So only column-0 ESM statements
 * OUTSIDE a fence are removed, consuming continuation lines of a multi-line
 * statement.
 *
 * FAIL-LOUD, never silently partial (the bundle-builder posture): a
 * continuation scan that hits EOF or runs past
 * {@link MAX_ESM_CONTINUATION_LINES} without a terminator is either malformed
 * ESM or a prose false-positive — both would silently swallow document
 * content — so it THROWS instead of consuming (the markdown-tree adapter maps
 * the throw to a `PageLoadError` naming the page).
 */
export function stripMdxModuleLines(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let fence: string | null = null; // the opening fence's marker while open

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const [, marker, rest] = fenceMatch;
      // CommonMark closer rules: same character, at least the opener's
      // length, and NO info string — a ```` opener is not closed by an inner
      // ``` (that inner fence is content, e.g. a "how to write an MDX page"
      // example), and a ```ts line inside an open fence is content too.
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === "") {
        fence = null;
      }
      out.push(line);
      continue;
    }
    // A real MDX ESM statement is at column 0 and outside any fence.
    if (fence === null && /^(import|export)\s/.test(line)) {
      // Consume continuation lines ONLY when the line clearly opens a multi-line
      // construct (trailing `{`/`(`/`[`/`,`) — so a single-line `export default
      // Foo` with no terminator can never run the scan away into the prose that
      // follows.
      if (/[{([,]\s*$/.test(line)) {
        const start = i;
        i++;
        while (i < lines.length && !isEsmTerminatorCandidate(lines[i])) {
          if (i - start > MAX_ESM_CONTINUATION_LINES) {
            throw new Error(
              `unterminated top-level ESM statement starting at line ${start + 1} ` +
                `("${line.slice(0, 60)}") — refusing to strip further (it would silently ` +
                `swallow document prose); fix the statement or disable stripMdxModules`,
            );
          }
          i++;
        }
        if (i >= lines.length) {
          throw new Error(
            `top-level ESM statement starting at line ${start + 1} ("${line.slice(0, 60)}") ` +
              `never terminates before end of document — refusing to strip it (that would ` +
              `silently swallow the rest of the page); fix the statement or disable stripMdxModules`,
          );
        }
        if (!isEsmCloserLine(lines[i])) {
          // The candidate ends in a bracket/quote but doesn't LOOK like an
          // ESM closer (`see the survey (Fig 2)`, `  title: "Hello"`). Either
          // the opener was prose (stripping to here swallows a paragraph) or
          // the statement leaks residue into the body — both are silent
          // corruption; refuse instead.
          throw new Error(
            `top-level ESM statement starting at line ${start + 1} ("${line.slice(0, 60)}") ` +
              `runs into a line that does not look like an ESM closer ` +
              `("${lines[i].slice(0, 60)}") — refusing to strip it (that would silently ` +
              `corrupt the page); fix the statement or disable stripMdxModules`,
          );
        }
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/^\n+/, "");
}

/** True when any path segment is hidden (dot-prefixed) — editor droppings and
 *  VCS internals are never docs pages. */
function hasHiddenSegment(rel: string): boolean {
  return rel.split("/").some((segment) => segment.startsWith("."));
}

function matchesExtension(rel: string, extensions: readonly string[]): boolean {
  const lower = rel.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

/**
 * Read + split one page, mapping a malformed frontmatter block to a fail-loud
 * {@link PageLoadError} naming the page — an opened-but-broken block must
 * fail the build, never silently ride into the body of a knowledge document.
 */
function readEntry(root: string, rel: string, parseYaml: ParseYaml): TreeEntry {
  let raw: string;
  try {
    raw = readFileSync(join(root, rel), "utf8");
  } catch (err) {
    // Keep the adapter's error contract: a file deleted between walk and lazy
    // read (or a directory named like a page) surfaces as PageLoadError with
    // the page named, not a raw fs error.
    throw new PageLoadError(rel, err instanceof Error ? err.message : String(err), err);
  }
  const split = splitFrontmatterBlock(raw, parseYaml);
  if (split.kind === "none") {
    return { meta: {}, body: raw };
  }
  if (split.kind === "error") {
    throw new PageLoadError(rel, split.reason);
  }
  const data = split.data ?? {};
  return {
    meta: {
      title: typeof data.title === "string" ? data.title : undefined,
      description: typeof data.description === "string" ? data.description : undefined,
      // Passed through raw — the core's tag narrower (`normalizeFrontmatterTags`)
      // drops non-strings at render.
      tags: data.tags,
    },
    body: split.body,
  };
}

/**
 * Build a doc source over a markdown/MDX content tree. Enumeration is
 * deterministic (sorted, `/`-separated, hidden segments excluded); each
 * page's frontmatter (`title`/`description`/`tags`) resolves LAZILY on first
 * access and is cached per page — a page a filter skips (e.g. hundreds of
 * api-reference stubs) costs a directory entry, not a read+parse.
 */
export async function createMarkdownTreeSource(
  options: MarkdownTreeSourceOptions,
): Promise<DocSource> {
  const { root, parseYaml } = options;
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const stripMdxModules = options.stripMdxModules ?? true;

  const relPaths = (await readdir(root, { recursive: true }))
    .map((rel) => rel.replaceAll("\\", "/"))
    .filter((rel) => matchesExtension(rel, extensions) && !hasHiddenSegment(rel))
    .sort();

  // Per-source cache: title/description/tags/loadBody share one read+parse.
  const entries = new Map<string, TreeEntry>();
  const entryFor = (rel: string): TreeEntry => {
    const cached = entries.get(rel);
    if (cached) return cached;
    const entry = readEntry(root, rel, parseYaml);
    entries.set(rel, entry);
    return entry;
  };

  const pages: DocSourcePage[] = relPaths.map((rel) => ({
    path: rel,
    get title(): string | undefined {
      return entryFor(rel).meta.title;
    },
    get description(): string | undefined {
      return entryFor(rel).meta.description;
    },
    get tags(): unknown {
      return entryFor(rel).meta.tags;
    },
    loadBody: async () => {
      const { body } = entryFor(rel);
      if (!(stripMdxModules && rel.toLowerCase().endsWith(".mdx"))) return body;
      try {
        return stripMdxModuleLines(body);
      } catch (err) {
        // The strip refuses to consume an unterminated/prose-shaped ESM run
        // (silent content loss); surface it fail-loud with the page named.
        throw new PageLoadError(rel, err instanceof Error ? err.message : String(err), err);
      }
    },
  }));

  return { getPages: () => pages };
}
