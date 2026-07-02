/**
 * Lenient OKF ingest parsing (#4207, ADR-0028 §5).
 *
 * OKF is Atlas's at-rest normal form, **not** an ingest requirement: a customer
 * points at a plain folder of markdown and it just works. So this parser is
 * deliberately more forgiving than the spike's strict `parseBundle`
 * (`lib/semantic/okf/parse.ts`), which requires every file to carry valid
 * frontmatter with a non-empty `type` and drops the rest into a mapping report.
 *
 * Leniency rules (AC "Lenient ingest"):
 *   - A file with NO frontmatter block ingests fine — its whole content is the
 *     body, `type` is stamped `Document`, and `title` comes from the first `#`
 *     heading (else the filename stem).
 *   - A file WITH frontmatter but missing `type` / `title` gets the same stamps,
 *     so every STORED document is conformant OKF even when the source wasn't.
 *   - A file with a frontmatter block that is genuinely MALFORMED (opened `---`
 *     but unterminated, invalid YAML, or a non-mapping) is REJECTED with an
 *     actionable per-file error — never silently skipped, never stamped over a
 *     parse the author clearly intended.
 *
 * Reserved OKF basenames (`index.md`, `log.md`) are navigation / history, not
 * concepts — skipped, mirroring the spike's `RESERVED_BASENAMES` name set (here
 * compared case-insensitively, a deliberate slight superset). They carry no
 * `knowledge_documents` row; the tree's navigation is regenerable. Non-`.md`
 * entries (assets) are skipped too.
 *
 * The markdown link graph is extracted here, once, at ingest — intra-bundle
 * relative links only, resolved against the source document's directory to a
 * bundle-absolute path so `knowledge_links.target_path` lines up with other
 * documents' `path` (ADR-0028 §5 / migration 0163).
 */

import * as yaml from "js-yaml";
import type { InteropFile } from "@atlas/api/lib/semantic/okf";
import type { BundleEntryError } from "./bundle-archive";

/** Default OKF `type` stamped on a document that arrived without one. */
export const DEFAULT_OKF_TYPE = "Document";

/** Reserved OKF filenames — navigation/history, never concept documents. */
const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

const FRONTMATTER_OPEN = /^---\r?\n/;

/** One extracted intra-bundle markdown link. */
export interface LenientLink {
  /** Bundle-absolute path the link resolves to (matches a document's `path`). */
  readonly targetPath: string;
  /** The `[anchor]` text, trimmed, or null when empty. */
  readonly anchorText: string | null;
}

/**
 * A parsed, conformant-by-construction knowledge document ready to persist. The
 * OKF frontmatter fields mirror `knowledge_documents` columns; `type`/`title`
 * are always non-empty (stamped when the source omitted them).
 */
export interface LenientDoc {
  readonly path: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly resource: string | null;
  readonly tags: readonly string[];
  /** OKF `timestamp` frontmatter, normalized to ISO-8601, or null. */
  readonly timestamp: string | null;
  readonly body: string;
  readonly links: readonly LenientLink[];
}

export interface LenientParseResult {
  readonly docs: readonly LenientDoc[];
  /** Per-file rejections (malformed frontmatter). Never silently dropped. */
  readonly errors: readonly BundleEntryError[];
  /**
   * Non-`.md` entries skipped by design (assets — only markdown ingests).
   * Surfaced as a count so a mostly-binary bundle ("3 documents ingested" out
   * of 300 files) doesn't read as fully ingested.
   */
  readonly skippedNonMarkdown: number;
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

/** Filename stem without the `.md` extension — the title fallback of last resort. */
function stem(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

type FrontmatterSplit =
  | { readonly ok: true; readonly frontmatter: Record<string, unknown>; readonly body: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Split a document into frontmatter + body, leniently. A file with no `---`
 * opener is treated as pure markdown (empty frontmatter, whole content is the
 * body) — NOT an error. Only a file that opens a frontmatter block and then
 * fails to close/parse it (or parses to a non-mapping) is an error. A parsed
 * mapping WITHOUT `type` is intentionally NOT an error here — `type` is stamped
 * by the caller.
 */
export function splitLenientFrontmatter(content: string): FrontmatterSplit {
  if (!FRONTMATTER_OPEN.test(content)) {
    return { ok: true, frontmatter: {}, body: content };
  }
  const afterOpen = content.replace(FRONTMATTER_OPEN, "");
  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { ok: false, reason: "unterminated frontmatter block" };
  }
  const rawYaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length).replace(/^\r?\n/, "");

  // An empty frontmatter block (`---\n---`) is "no fields", not malformed. Guard
  // before `yaml.load` — js-yaml throws "input is empty" on a blank document.
  if (rawYaml.trim() === "") {
    return { ok: true, frontmatter: {}, body };
  }

  let data: unknown;
  try {
    data = yaml.load(rawYaml);
  } catch (err) {
    return {
      ok: false,
      reason: `frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // An empty frontmatter block (`---\n---`) parses to null/undefined — treat as
  // "no fields", not a malformed mapping.
  if (data === null || data === undefined) {
    return { ok: true, frontmatter: {}, body };
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter is not a YAML mapping" };
  }
  return { ok: true, frontmatter: data as Record<string, unknown>, body };
}

/** Narrow an unknown frontmatter value to a non-empty trimmed string, else null. */
function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** OKF `tags` → a clean `string[]` (drops non-strings), preserving order. */
function tagsField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t !== "");
}

/**
 * Normalize an OKF `timestamp` to ISO-8601, or null. js-yaml parses an ISO
 * scalar into a `Date` (YAML timestamp type); a bare string is parsed here.
 * An unparseable value normalizes to null rather than failing the whole doc —
 * the document is still valuable without a timestamp.
 */
function timestampField(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * First top-level `# Heading` text, or null. Hand-scanned rather than a
 * `/^#\s+.../m` regex — the latter backtracks polynomially on hostile
 * whitespace runs and this walks untrusted bundle content (CodeQL
 * js/polynomial-redos, same posture as `okf/parse.ts::topLevelHeading`).
 */
function firstHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    if (line.charAt(0) !== "#") continue;
    const second = line.charAt(1);
    if (second !== " " && second !== "\t") continue;
    const text = line.slice(2).trim();
    if (text !== "") return text;
  }
  return null;
}

// Inline markdown link: `[anchor](target)` with an optional `"title"`. The two
// character classes are single-star / single-plus over disjoint sets (no nested
// or adjacent-optional quantifiers), so the match stays linear on untrusted
// input — deliberately NOT the classic `\[.*\]\(.*\)` shape.
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** True for links Atlas doesn't track: absolute URLs, mailto, protocol-relative, pure anchors. */
function isExternalTarget(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) || // scheme: http:, https:, mailto:, tel:, …
    target.startsWith("//") || // protocol-relative
    target.startsWith("#") // in-page anchor
  );
}

/**
 * Resolve a relative link target against the source document's directory into a
 * bundle-absolute path, stripping any `#fragment` / `?query`. Returns null when
 * the target is external or resolves above the bundle root (can't be an
 * intra-collection edge).
 */
export function resolveLinkTarget(sourcePath: string, rawTarget: string): string | null {
  const target = rawTarget.split("#")[0].split("?")[0].trim();
  if (target === "" || isExternalTarget(target)) return null;
  const baseSegments = target.startsWith("/") ? [] : dirname(sourcePath).split("/").filter((s) => s !== "");
  const stack = [...baseSegments];
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null; // escapes the bundle root
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? null : stack.join("/");
}

/** Extract intra-bundle links from a body, de-duplicated on (target, anchor). */
export function extractLinks(sourcePath: string, body: string): LenientLink[] {
  const seen = new Set<string>();
  const links: LenientLink[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const anchorRaw = match[1].trim();
    const targetPath = resolveLinkTarget(sourcePath, match[2]);
    if (targetPath === null) continue;
    const anchorText = anchorRaw === "" ? null : anchorRaw;
    const key = `${targetPath} ${anchorText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetPath, anchorText });
  }
  return links;
}

/**
 * Parse an extracted bundle's files into conformant knowledge documents.
 * Reserved / non-`.md` entries are skipped; malformed-frontmatter files land in
 * `errors` (rejected, actionable) while the rest still parse.
 */
export function parseLenientBundle(files: readonly InteropFile[]): LenientParseResult {
  const docs: LenientDoc[] = [];
  const errors: BundleEntryError[] = [];
  let skippedNonMarkdown = 0;

  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".md")) {
      skippedNonMarkdown++;
      continue;
    }
    if (RESERVED_BASENAMES.has(basename(file.path).toLowerCase())) continue;

    const split = splitLenientFrontmatter(file.content);
    if (!split.ok) {
      errors.push({ path: file.path, reason: split.reason });
      continue;
    }
    const { frontmatter, body } = split;
    const title =
      stringField(frontmatter.title) ?? firstHeading(body) ?? stem(file.path);

    docs.push({
      path: file.path,
      type: stringField(frontmatter.type) ?? DEFAULT_OKF_TYPE,
      title,
      description: stringField(frontmatter.description),
      resource: stringField(frontmatter.resource),
      tags: tagsField(frontmatter.tags),
      timestamp: timestampField(frontmatter.timestamp),
      body,
      links: extractLinks(file.path, body),
    });
  }

  return { docs, errors, skippedNonMarkdown };
}
