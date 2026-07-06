/**
 * The OKF wire contract — single-homed (#4373, PRD #4372).
 *
 * One leaf module owns every constant and mechanical helper that Atlas's OKF
 * surfaces previously declared in parallel and held equal only by drift-pin
 * tests: the ingest parsers (`packages/api`'s strict `semantic/okf/parse.ts`
 * and lenient `knowledge/parse-lenient.ts`), the knowledge mirror, the ingest
 * caps, and every bundle importer. `packages/api` imports THIS module; no
 * importer ever depends on `@atlas/api` at runtime (the adapter package's
 * round-trip test dev-deps it) — the dependency direction is api → wire,
 * one-way by construction.
 *
 * Deliberately ZERO imports (a leaf): a doc-source adapter — including one
 * vendored outside this repo — gets the frontmatter split, heading scan, and
 * basename utilities without pulling in anything else. The one external need,
 * YAML parsing, is INJECTED into {@link splitFrontmatterBlock} rather than
 * imported, so the package's runtime dependency set stays `fflate`-only
 * (issue #4373 acceptance criterion); `packages/api` binds `js-yaml` once in
 * `semantic/okf/md-utils.ts`.
 */

// ---------------------------------------------------------------------------
// Reserved basenames
// ---------------------------------------------------------------------------

/** OKF navigation basename — regenerated per directory, never a concept doc. */
export const OKF_INDEX_BASENAME = "index.md";

/** OKF history basename — append-only log, never a concept doc. */
export const OKF_LOG_BASENAME = "log.md";

/**
 * Reserved OKF filenames — navigation/history, never concept documents. The
 * ingest parsers SILENTLY skip these (the lenient parser compares
 * case-insensitively — a deliberate slight superset; the strict parser
 * matches exactly), which is why the bundle builder's path derivation must
 * never emit one (issue #4367: 8 of 165 portal docs vanished that way before
 * the reserved-rename mapping).
 */
export const RESERVED_BASENAMES: ReadonlySet<string> = new Set([
  OKF_INDEX_BASENAME,
  OKF_LOG_BASENAME,
]);

// ---------------------------------------------------------------------------
// Frontmatter field set
// ---------------------------------------------------------------------------

/**
 * The OKF frontmatter fields Atlas reads and writes on concept documents —
 * `type` is the one spec-required key; the rest are the spec's recommended
 * keys. `okf_version` (root index only) and the {@link ATLAS_EXTENSION_KEY}
 * extension ride alongside; unknown keys are spec-legal and preserved.
 */
export interface OkfWireFrontmatter {
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly resource?: string;
  readonly tags?: readonly string[];
  /** ISO-8601 timestamp. */
  readonly timestamp?: string;
}

/** The field set as a value, for consumers that enumerate the contract. */
export const OKF_FRONTMATTER_FIELDS: readonly (keyof OkfWireFrontmatter)[] = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
];

/** Default OKF `type` stamped on a document that arrived without one, and the
 *  `type` every bundle builder emits. */
export const DEFAULT_OKF_TYPE = "Document";

/** The OKF spec version Atlas emits (root `index.md` `okf_version` frontmatter). */
export const OKF_VERSION = "0.1";

/** The Atlas extension namespace in OKF frontmatter (spec-legal unknown key) —
 *  provenance on mirrored documents, round-trip payloads on exports. */
export const ATLAS_EXTENSION_KEY = "atlas";

// ---------------------------------------------------------------------------
// Ingest-cap defaults
// ---------------------------------------------------------------------------
// The server reads these through the settings registry
// (`@atlas/api/lib/knowledge/ingest-limits`, keys `ATLAS_KNOWLEDGE_INGEST_*`);
// bundle builders validate against them at GENERATION time so an overflow
// surfaces where the site owner can act on it.

/** Max concept documents per bundle. */
export const DEFAULT_INGEST_MAX_DOCS = 1000;

/** Max decoded size of any single document, in bytes (1 MB). */
export const DEFAULT_INGEST_MAX_DOC_BYTES = 1_000_000;

/** Max bundle size, in bytes (25 MB) — applied to BOTH the decoded total and
 *  the compressed archive / raw upload body. */
export const DEFAULT_INGEST_MAX_BUNDLE_BYTES = 25_000_000;

// ---------------------------------------------------------------------------
// Mechanical markdown helpers
// ---------------------------------------------------------------------------
// Shared by the strict spike parser (`semantic/okf/frontmatter.ts` +
// `parse.ts`) and the lenient ingest parser (`knowledge/parse-lenient.ts`).
// The parsers deliberately DIFFER on policy (is a missing frontmatter block an
// error? is a missing `type` an error?) — that policy stays in each parser;
// only the mechanics live here, expressed as a three-way split result so
// neither policy is baked in.

/** Path basename without a Node `path` dependency (bundle paths are always `/`-separated). */
export function mdBasename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * A top-level `# Heading` line's text, or null. String ops instead of a
 * regex: `/^#\s+(.+?)\s*$/` backtracks polynomially on hostile whitespace
 * runs, and this runs on untrusted bundle content (CodeQL
 * js/polynomial-redos).
 */
export function topLevelHeading(line: string): string | null {
  if (line.charAt(0) !== "#") return null;
  const second = line.charAt(1);
  if (second !== " " && second !== "\t") return null;
  const text = line.slice(2).trim();
  return text === "" ? null : text;
}

const FRONTMATTER_OPEN = /^---\r?\n/;

/**
 * A YAML document parser for {@link splitFrontmatterBlock} — injected (e.g.
 * `js-yaml`'s `load`) so this module stays dependency-free. May throw on
 * malformed input; the splitter converts the throw into an `error` result.
 */
export type ParseYaml = (raw: string) => unknown;

/**
 * Mechanical frontmatter split, policy-free:
 *  - `none`  — no `---` opener (the lenient parser treats this as pure
 *    markdown; the strict parser as a conformance failure);
 *  - `ok`    — a parsed YAML mapping (`data: null` for an empty block, which
 *    each parser interprets under its own policy);
 *  - `error` — an opened block that is unterminated, unparseable, or not a
 *    mapping (both parsers reject these, never silently skip).
 */
export type FrontmatterBlockSplit =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly data: Record<string, unknown> | null; readonly body: string }
  | { readonly kind: "error"; readonly reason: string };

export function splitFrontmatterBlock(
  content: string,
  parseYaml: ParseYaml,
): FrontmatterBlockSplit {
  if (!FRONTMATTER_OPEN.test(content)) return { kind: "none" };
  const afterOpen = content.replace(FRONTMATTER_OPEN, "");
  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { kind: "error", reason: "unterminated frontmatter block" };
  }
  const rawYaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length).replace(/^\r?\n/, "");

  // An empty frontmatter block (`---\n---`) is "no fields", not malformed.
  // Guard before the YAML parse — js-yaml throws "input is empty" on a blank
  // document.
  if (rawYaml.trim() === "") {
    return { kind: "ok", data: null, body };
  }

  let data: unknown;
  try {
    data = parseYaml(rawYaml);
  } catch (err) {
    return {
      kind: "error",
      reason: `frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // A blank-after-comment document also parses to null/undefined.
  if (data === null || data === undefined) {
    return { kind: "ok", data: null, body };
  }
  // Only a PLAIN mapping may wear the Record type: js-yaml parses a lone
  // scalar timestamp (`---\n2020-01-01\n---`) into a `Date`, and an injected
  // parser could return a `Map` or class instance — all `typeof "object"`,
  // none of them the mapping the contract promises. Reject rather than let
  // an "ok" result lie about its shape.
  if (typeof data !== "object" || Array.isArray(data)) {
    return { kind: "error", reason: "frontmatter is not a YAML mapping" };
  }
  const proto: unknown = Object.getPrototypeOf(data);
  if (proto !== Object.prototype && proto !== null) {
    return { kind: "error", reason: "frontmatter is not a YAML mapping" };
  }
  return { kind: "ok", data: data as Record<string, unknown>, body };
}
