/**
 * The MkDocs OKF importer (#4392, PRD #4372) — the markdown-tree adapter plus
 * a nav filter keyed on MkDocs's `mkdocs.yml` config: only pages reachable
 * from the `nav:` tree collect; everything else under the `docs_dir`
 * (retired pages, drafts, includes) is declined by the `filter` hook and
 * lands in the core's counted `skipped.filtered` bucket — visible, never
 * silent. MkDocs is the cheapest importer case: the `docs_dir` is
 * markdown-native, no MDX module syntax to strip.
 *
 * The config is parsed STRUCTURALLY as unknown YAML (via the injected
 * {@link ParseYaml}, so runtime deps stay `fflate`-only) — no dependency on
 * MkDocs's config schema. The nav walk exploits the one invariant across every
 * MkDocs nav shape (bare path, `Title: path.md`, `Section: [ …nested… ]`): a
 * page path only ever appears as a STRING that is EITHER a bare list element
 * OR the value of a single-key title mapping. Titles (mapping KEYS) and
 * external-link values (`Community: https://…`) are never tree pages, so the
 * walker recurses through every list and mapping VALUE and collects the
 * strings that normalize to a relative page path (shape only — membership
 * against the actual tree happens later, at the filter).
 *
 * A `nav:`-absent config is MkDocs's auto-discovery mode: with no navigation
 * to filter against, the whole `docs_dir` collects, which the deterministic
 * packer renders byte-stable. `nav:` present but resolving
 * to zero pages, an unreadable/malformed config, or a non-string `docs_dir`
 * FAIL LOUD ({@link NavManifestError}) — a broken config must fail the build
 * where the site owner can act on it, never quietly produce an empty or
 * over-full bundle.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NavManifestError } from "./errors";
import {
  createMarkdownTreeSource,
  DEFAULT_EXTENSIONS,
  type MarkdownTreeSourceOptions,
} from "./markdown-tree";
import type { DocSource, DocSourcePage } from "./types";
import type { ParseYaml } from "./wire";

/** Config filename probed at the source root, in precedence order (MkDocs
 *  accepts either spelling). */
export const MKDOCS_CONFIG_NAMES = ["mkdocs.yml", "mkdocs.yaml"] as const;

/** MkDocs's default documentation directory, relative to the config root. */
export const MKDOCS_DEFAULT_DOCS_DIR = "docs";

/** The resolved navigation of one `mkdocs.yml`. */
export interface MkDocsNav {
  /** Config path (relative to the source root) the navigation came from. */
  readonly configPath: string;
  /** The resolved `docs_dir` (relative to the source root; MkDocs default `docs`). */
  readonly docsDir: string;
  /**
   * Nav-reachable page paths, normalized to the tree adapter's path shape
   * minus the extension: `/`-separated, no leading slash, no `.md`/`.mdx`
   * (the filter strips `page.path`'s extension before membership). `null`
   * when the config has no `nav:` — MkDocs auto-discovery, so the whole
   * `docs_dir` collects unfiltered.
   */
  readonly pages: ReadonlySet<string> | null;
}

export interface MkDocsSourceOptions extends Omit<MarkdownTreeSourceOptions, "root"> {
  /** The MkDocs PROJECT root — where `mkdocs.yml` lives. The markdown-tree
   *  walk is rooted at the resolved `docs_dir` under it, so archive paths are
   *  clean (no `docs/` prefix leak). */
  readonly root: string;
  /**
   * Config filename relative to `root`. Default: probe `mkdocs.yml`, then
   * `mkdocs.yaml`; neither present is a {@link NavManifestError}.
   */
  readonly config?: string;
}

export interface MkDocsSource {
  /** The underlying markdown-tree doc source (full `docs_dir` tree; the nav
   *  does not narrow enumeration — filtering happens at collect so skips are
   *  counted). */
  readonly source: DocSource;
  /**
   * The nav predicate for the core collect's `filter` hook: `true` iff the
   * page is reachable from the config's `nav:` (or always `true` when the
   * config has no `nav:`). Pass to `collectPages`/`buildOkfBundle`.
   */
  readonly filter: (page: DocSourcePage) => boolean;
  /** The resolved navigation — which config won, the `docs_dir`, and the
   *  allowed-path set (or `null` for auto-discovery). */
  readonly nav: MkDocsNav;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize one nav entry onto the tree adapter's path shape. Returns null
 *  for entries that can never name a tree page (external links, absolutes,
 *  empties). */
function normalizeNavEntry(entry: string, extensions: readonly string[]): string | null {
  let path = entry.trim();
  // External links can never name a tree page: full protocol (`https://…`)
  // or protocol-relative (`//host/…`).
  if (path === "" || path.includes("://") || path.startsWith("//")) return null;
  while (path.startsWith("/")) path = path.slice(1);
  path = stripPageExtension(path, extensions);
  return path === "" ? null : path;
}

/** Strip a trailing page extension (case-insensitive) so nav entries (which
 *  carry the `.md` MkDocs requires) and tree paths compare on the same stem.
 *  The filter strips the EFFECTIVE extension set for the same reason the
 *  Mintlify importer does — a custom `extensions` option must not leave every
 *  enumerated path unstripped and filter the whole tree out. */
function stripPageExtension(
  path: string,
  extensions: readonly string[] = DEFAULT_EXTENSIONS,
): string {
  const lower = path.toLowerCase();
  for (const ext of extensions) {
    const suffix = ext.toLowerCase();
    if (lower.endsWith(suffix)) return path.slice(0, -suffix.length);
  }
  return path;
}

/**
 * Recursive walk of one nav node: collect the page-path strings, recurse into
 * everything else. A nav list holds bare-string paths and single-key title
 * mappings; a title mapping's VALUE is either a string path or a nested nav
 * list. Titles (mapping keys) and external-link values normalize to null and
 * are dropped — same posture as the Mintlify walker's "strings only under
 * pages" invariant.
 */
function collectNavPages(
  node: unknown,
  extensions: readonly string[],
  out: Set<string>,
): void {
  if (typeof node === "string") {
    const normalized = normalizeNavEntry(node, extensions);
    if (normalized !== null) out.add(normalized);
    return;
  }
  if (Array.isArray(node)) {
    for (const element of node) collectNavPages(element, extensions, out);
    return;
  }
  if (!isRecord(node)) return;
  // Only VALUES can name a page; keys are section/link titles.
  for (const value of Object.values(node)) collectNavPages(value, extensions, out);
}

/** Resolve `docs_dir` from a parsed config document (MkDocs default `docs`).
 *  A present-but-non-string `docs_dir` is fail-loud — a config bug that would
 *  otherwise silently root the walk at the default and skip every page. */
function resolveDocsDir(doc: Record<string, unknown>, configPath: string): string {
  if (!("docs_dir" in doc)) return MKDOCS_DEFAULT_DOCS_DIR;
  const value = doc.docs_dir;
  if (typeof value !== "string" || value.trim() === "") {
    throw new NavManifestError(
      configPath,
      'its "docs_dir" is not a non-empty string — cannot locate the documentation directory',
    );
  }
  return value.trim();
}

/**
 * Parse a `mkdocs.yml` document and resolve its `docs_dir` + `nav:` to the set
 * of reachable page paths. Fail-loud ({@link NavManifestError}) on unparseable
 * YAML, a non-mapping document, a non-list `nav:`, a non-string `docs_dir`, or
 * a `nav:` that yields zero page paths. A config with NO `nav:` resolves to
 * `pages: null` (MkDocs auto-discovery — the whole `docs_dir` collects).
 */
export function parseMkDocsConfig(
  raw: string,
  configPath: string,
  parseYaml: ParseYaml,
  extensions: readonly string[] = DEFAULT_EXTENSIONS,
): MkDocsNav {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new NavManifestError(
      configPath,
      `not valid YAML (${err instanceof Error ? err.message : String(err)})`,
      err,
    );
  }
  if (!isRecord(doc)) {
    throw new NavManifestError(configPath, "the config document is not a YAML mapping");
  }
  const docsDir = resolveDocsDir(doc, configPath);
  if (!("nav" in doc)) {
    // MkDocs auto-discovery: no nav to filter against, so the whole docs_dir
    // collects. Not an error — a valid, common config shape.
    return { configPath, docsDir, pages: null };
  }
  if (!Array.isArray(doc.nav)) {
    throw new NavManifestError(
      configPath,
      'its "nav" is not a list — MkDocs navigation is always a YAML sequence',
    );
  }
  const pages = new Set<string>();
  collectNavPages(doc.nav, extensions, pages);
  if (pages.size === 0) {
    throw new NavManifestError(
      configPath,
      "its nav resolves to no page paths — every tree page would be filtered out",
    );
  }
  return { configPath, docsDir, pages };
}

/** A truly ABSENT file — the only read failure the config probe may fall
 *  through. EACCES/EISDIR/EIO on a present `mkdocs.yml` must fail loud:
 *  falling through would silently resolve a stale `mkdocs.yaml` beside it. */
function isFileMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/** Read + parse the config at the source root: the explicit override, or
 *  `mkdocs.yml` falling back to `mkdocs.yaml`. */
async function loadNav(
  root: string,
  config: string | undefined,
  parseYaml: ParseYaml,
  extensions: readonly string[],
): Promise<MkDocsNav> {
  const candidates = config === undefined ? MKDOCS_CONFIG_NAMES : [config];
  let lastMissing: unknown;
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(join(root, candidate), "utf8");
    } catch (err) {
      if (isFileMissing(err)) {
        // intentionally ignored: a missing candidate falls through to the next
        // config name; running out of candidates fails loud below.
        lastMissing = err;
        continue;
      }
      throw new NavManifestError(
        candidate,
        `cannot read the config (${err instanceof Error ? err.message : String(err)})`,
        err,
      );
    }
    return parseMkDocsConfig(raw, candidate, parseYaml, extensions);
  }
  throw new NavManifestError(
    candidates[0],
    `no config at the source root "${root}" (looked for ${candidates.join(", ")})`,
    lastMissing,
  );
}

/**
 * Build a MkDocs doc source: {@link createMarkdownTreeSource} over the
 * resolved `docs_dir` plus the nav `filter` derived from the site's
 * `mkdocs.yml`. Usage:
 *
 * ```ts
 * const { source, filter } = await createMkDocsSource({ root, parseYaml });
 * const result = await buildOkfBundle(source, { prefix: "docs", filter });
 * // result.stats.skipped.filtered — pages under docs_dir but absent from nav
 * ```
 */
export async function createMkDocsSource(options: MkDocsSourceOptions): Promise<MkDocsSource> {
  const { config, root, ...treeOptions } = options;
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  // Config probe FIRST, sequentially: on a nonexistent root, racing the tree
  // walk would nondeterministically surface either the contextual
  // NavManifestError or readdir's raw ENOENT.
  const nav = await loadNav(root, config, options.parseYaml, extensions);
  let source: DocSource;
  try {
    source = await createMarkdownTreeSource({ ...treeOptions, root: join(root, nav.docsDir) });
  } catch (err) {
    // A config-named docs_dir that doesn't exist (e.g. a typo `docs_dir:
    // documentaion`) surfaces here as a raw readdir ENOENT — rewrap it as the
    // contextual NavManifestError so the site owner's actual mistake (a config
    // value) is named, matching the fail-loud posture of the config parse.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new NavManifestError(
        nav.configPath,
        `its "docs_dir" ("${nav.docsDir}") does not exist under the source root "${root}"`,
        err,
      );
    }
    throw err;
  }
  const pages = nav.pages;
  return {
    source,
    filter: (page) => pages === null || pages.has(stripPageExtension(page.path, extensions)),
    nav,
  };
}
