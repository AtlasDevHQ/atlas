/**
 * Deterministic `page.path` → archive-path derivation.
 *
 * The bundle-sync subtractive diff (`archiveAbsent`) keys on FULL bundle
 * paths, so this mapping must be a pure function of the page's own path — no
 * hashing, no ordering dependence, no per-build components. A slug rename
 * therefore reads as "old path absent + new path added" → archive + fresh
 * draft; that churn is expected, safe (never a hard delete), and documented.
 *
 * Two OKF realities shape the mapping:
 *   1. The ingest parser SILENTLY skips reserved basenames (`index.md`,
 *      `log.md` — navigation/history in a hand-authored OKF tree; the wire
 *      module's `RESERVED_BASENAMES`). Docs trees use `index.mdx` for real
 *      section-landing content, so a naive mapping drops a site's biggest
 *      overview pages without even a rejection row (issue #4367: 8 of 165
 *      portal docs vanished this way). A section landing is therefore FOLDED
 *      onto its section's own slug (`plugins/index.mdx` → `plugins.md`) —
 *      collision-free by construction for a valid docs site, because
 *      `plugins/index.mdx` and `plugins.mdx` already collide at the same URL
 *      there.
 *   2. Anything else that still lands on a reserved basename (a page
 *      literally named `log.mdx`, or an `index` that survives folding) gets a
 *      `-doc` suffix so it can never be silently dropped.
 */

import { InvalidPagePathError } from "./errors";
import { RESERVED_BASENAMES } from "./wire";

/** The archive-path STEM a folded ROOT `index` page lands on — `index.mdx`
 *  at the collection root becomes `<prefix>/overview.md`. */
export const ROOT_INDEX_STEM = "overview";

/** Page extensions a doc source can contain. */
const PAGE_EXTENSION = /\.(mdx|md)$/i;

/**
 * Normalize and validate a path into clean segments. Rejects traversal,
 * absolute paths, and empty input — the archive must extract under the
 * collection's relative tree (mirrors the ingest side's `normalizeBundlePath`
 * posture, but fails loud at generation instead of rejecting at ingest).
 */
function toSegments(raw: string, what: string): string[] {
  const unified = raw.replace(/\\/g, "/").trim();
  if (unified === "") throw new InvalidPagePathError(raw, `${what} is empty`);
  if (unified.startsWith("/") || /^[A-Za-z]:\//.test(unified)) {
    throw new InvalidPagePathError(raw, `${what} must be relative, got an absolute path`);
  }
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new InvalidPagePathError(raw, `${what} contains a ".." traversal segment`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new InvalidPagePathError(raw, `${what} has no path segments`);
  return segments;
}

/** Validate a bundle prefix (one or more plain path segments). Returns clean segments. */
export function normalizePrefix(prefix: string): string[] {
  return toSegments(prefix, "prefix");
}

/**
 * First path segment of a page path, lower-cased (`""` when invalid) — the
 * shared MECHANICS behind adapter stub predicates (e.g. a top-level
 * `api-reference/` rule). The predicate POLICY — which segment marks a stub,
 * and whether skipping is on by default — stays in each adapter/consumer;
 * single-homing the segment extraction just keeps two consumers of the same
 * rule (e.g. the Fumadocs adapter's built-in default and the docs portal's
 * predicate) from drifting apart.
 */
export function firstPathSegment(pagePath: string): string {
  const unified = pagePath.replace(/\\/g, "/").trim().replace(/^\.?\//, "");
  const idx = unified.indexOf("/");
  return (idx === -1 ? unified : unified.slice(0, idx)).toLowerCase();
}

export interface DerivedArchivePath {
  /** Archive-relative `.md` path (prefix NOT included). */
  readonly path: string;
  /** Set when the basename had to move off a reserved OKF name. */
  readonly renamedFromReserved: boolean;
}

/**
 * Derive the archive-relative `.md` path for a page path, deterministically:
 *
 *   `guides/setup.mdx`      → `guides/setup.md`
 *   `plugins/index.mdx`     → `plugins.md`        (section landing folds to the section slug)
 *   `index.mdx`             → `overview.md`       (root landing)
 *   `ops/log.mdx`           → `ops/log-doc.md`    (reserved basename — never silently droppable)
 */
export function deriveArchivePath(pagePath: string): DerivedArchivePath {
  const segments = toSegments(pagePath, "page.path");

  const last = segments[segments.length - 1];
  if (!PAGE_EXTENSION.test(last)) {
    throw new InvalidPagePathError(
      pagePath,
      `expected a .mdx/.md page file, got "${last}" — is this a page from a doc-source adapter?`,
    );
  }
  const stem = last.replace(PAGE_EXTENSION, "");
  if (stem === "") {
    throw new InvalidPagePathError(pagePath, "page filename has no stem");
  }

  // Fold a section landing onto the section's own slug — matches docs-site URL
  // semantics (`plugins/index.mdx` and `plugins.mdx` share a slug there, so
  // the fold target cannot belong to another page on a valid site).
  let outSegments: string[];
  if (stem.toLowerCase() === "index") {
    outSegments = segments.slice(0, -1);
    if (outSegments.length === 0) outSegments = [ROOT_INDEX_STEM];
  } else {
    outSegments = [...segments.slice(0, -1), stem];
  }

  // Anything still landing on a reserved basename (`log.mdx`; an `index`
  // directory name that became the basename after folding) gets `-doc` so the
  // ingest parser can never silently skip it.
  let renamedFromReserved = false;
  const basename = `${outSegments[outSegments.length - 1]}.md`;
  if (RESERVED_BASENAMES.has(basename.toLowerCase())) {
    outSegments[outSegments.length - 1] = `${outSegments[outSegments.length - 1]}-doc`;
    renamedFromReserved = true;
  }

  return { path: `${outSegments.join("/")}.md`, renamedFromReserved };
}
