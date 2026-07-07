/**
 * The Mintlify OKF importer (#4391, PRD #4372) — exactly what the README
 * promised: the markdown-tree adapter plus a nav filter keyed on Mintlify's
 * manifest (`docs.json`, legacy `mint.json`). Only pages reachable from the
 * configured navigation collect; everything else on disk (snippets, retired
 * pages, drafts) is declined by the `filter` hook and lands in the core's
 * counted `skipped.filtered` bucket — visible, never silent.
 *
 * The manifest is parsed STRUCTURALLY as unknown JSON — no dependency on
 * Mintlify's config types or packages (runtime deps stay `fflate`-only). The
 * walk exploits the one invariant that holds across every navigation shape
 * (tabs, anchors, dropdowns, versions, languages, arbitrarily nested groups,
 * and the flat legacy `mint.json` group array): a page path only ever appears
 * as a STRING ELEMENT OF A `pages` ARRAY. Strings anywhere else (`href`,
 * `openapi`, icons, division titles) are never pages, so the walker recurses
 * through the known division keys and collects strings only under `pages`.
 *
 * FAIL-LOUD on a missing/malformed/unresolvable manifest
 * ({@link NavManifestError}) — a broken manifest must fail the build where
 * the site owner can act on it, never quietly produce an empty or over-full
 * bundle.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NavManifestError } from "./errors";
import { createMarkdownTreeSource, type MarkdownTreeSourceOptions } from "./markdown-tree";
import type { DocSource, DocSourcePage } from "./types";

/** Manifest filenames probed at the source root, in precedence order. */
export const MINTLIFY_MANIFEST_NAMES = ["docs.json", "mint.json"] as const;

/** The resolved navigation of one Mintlify manifest. */
export interface MintlifyNav {
  /** Manifest path (relative to the source root) the navigation came from. */
  readonly manifestPath: string;
  /**
   * Nav-reachable page paths, normalized to the tree adapter's shape:
   * `/`-separated, no leading slash, no `.md`/`.mdx` extension.
   */
  readonly pages: ReadonlySet<string>;
}

export interface MintlifySourceOptions
  extends Omit<MarkdownTreeSourceOptions, "root" | "parseYaml">,
    Pick<MarkdownTreeSourceOptions, "root" | "parseYaml"> {
  /**
   * Manifest filename relative to `root`. Default: probe `docs.json`, then
   * legacy `mint.json`; neither present is a {@link NavManifestError}.
   */
  readonly manifest?: string;
}

export interface MintlifySource {
  /** The underlying markdown-tree doc source (full tree; the nav does not
   *  narrow enumeration — filtering happens at collect so skips are counted). */
  readonly source: DocSource;
  /**
   * The nav predicate for the core collect's `filter` hook: `true` iff the
   * page is reachable from the manifest's navigation. Pass to
   * `collectPages`/`buildOkfBundle` (compose manually if you have your own
   * filter on top).
   */
  readonly filter: (page: DocSourcePage) => boolean;
  /** The resolved navigation — which manifest won, and the allowed-path set. */
  readonly nav: MintlifyNav;
}

/** Navigation division keys whose values may (transitively) hold `pages`
 *  arrays — the docs.json navigation schema plus the legacy mint.json group
 *  array (which arrives as the `navigation` value itself). */
const NAV_DIVISION_KEYS = [
  "languages",
  "versions",
  "tabs",
  "anchors",
  "dropdowns",
  "groups",
  "global",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize one nav entry onto the tree adapter's path shape. Returns null
 *  for entries that can never name a tree page (external links, empties). */
function normalizeNavEntry(entry: string): string | null {
  let path = entry.trim();
  if (path === "" || path.includes("://")) return null;
  while (path.startsWith("/")) path = path.slice(1);
  path = stripPageExtension(path);
  return path === "" ? null : path;
}

/** Strip a trailing `.md`/`.mdx` (case-insensitive) — nav entries are
 *  extension-less by convention, tree paths carry the extension. */
function stripPageExtension(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mdx")) return path.slice(0, -4);
  if (lower.endsWith(".md")) return path.slice(0, -3);
  return path;
}

/** Recursive walk of one navigation node: collect strings under `pages`,
 *  recurse into nested groups and every known division key. */
function collectNavPages(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    // The legacy mint.json navigation is a bare array of group objects; a
    // division key's value is an array of division objects.
    for (const element of node) collectNavPages(element, out);
    return;
  }
  if (!isRecord(node)) return;
  const pages = node.pages;
  if (Array.isArray(pages)) {
    for (const entry of pages) {
      if (typeof entry === "string") {
        const normalized = normalizeNavEntry(entry);
        if (normalized !== null) out.add(normalized);
      } else {
        collectNavPages(entry, out); // nested group object
      }
    }
  }
  for (const key of NAV_DIVISION_KEYS) {
    if (key in node) collectNavPages(node[key], out);
  }
}

/**
 * Parse a Mintlify manifest document (`docs.json` or legacy `mint.json`) and
 * resolve its navigation to the set of reachable page paths. Fail-loud
 * ({@link NavManifestError}) on unparseable JSON, a non-object document, a
 * missing `navigation` key, or a navigation that yields zero page paths.
 */
export function parseMintlifyNav(raw: string, manifestPath: string): MintlifyNav {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new NavManifestError(
      manifestPath,
      `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      err,
    );
  }
  if (!isRecord(doc)) {
    throw new NavManifestError(manifestPath, "the manifest document is not a JSON object");
  }
  if (!("navigation" in doc)) {
    throw new NavManifestError(manifestPath, 'the manifest has no "navigation" key');
  }
  const pages = new Set<string>();
  collectNavPages(doc.navigation, pages);
  if (pages.size === 0) {
    throw new NavManifestError(
      manifestPath,
      "its navigation resolves to no page paths — every tree page would be filtered out",
    );
  }
  return { manifestPath, pages };
}

/** Read + parse the manifest at the source root: the explicit override, or
 *  `docs.json` falling back to legacy `mint.json`. */
async function loadNav(root: string, manifest: string | undefined): Promise<MintlifyNav> {
  const candidates = manifest === undefined ? MINTLIFY_MANIFEST_NAMES : [manifest];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(join(root, candidate), "utf8");
    } catch {
      // intentionally ignored: a missing candidate falls through to the next
      // manifest name; running out of candidates fails loud below.
      continue;
    }
    return parseMintlifyNav(raw, candidate);
  }
  throw new NavManifestError(
    candidates.join(" / "),
    `no readable manifest at the source root (looked for ${candidates.join(", ")})`,
  );
}

/**
 * Build a Mintlify doc source: {@link createMarkdownTreeSource} over `root`
 * plus the nav `filter` derived from the site's manifest. Usage:
 *
 * ```ts
 * const { source, filter } = await createMintlifySource({ root, parseYaml });
 * const result = await buildOkfBundle(source, { prefix: "docs", filter });
 * // result.stats.skipped.filtered — pages on disk but absent from nav
 * ```
 */
export async function createMintlifySource(
  options: MintlifySourceOptions,
): Promise<MintlifySource> {
  const { manifest, ...treeOptions } = options;
  const [nav, source] = await Promise.all([
    loadNav(options.root, manifest),
    createMarkdownTreeSource(treeOptions),
  ]);
  return {
    source,
    filter: (page) => nav.pages.has(stripPageExtension(page.path)),
    nav,
  };
}
