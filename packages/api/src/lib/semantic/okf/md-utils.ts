/**
 * Shared markdown/frontmatter leaf helpers for the two OKF parsers — the
 * strict spike parser (`./frontmatter.ts` + `./parse.ts`, conformance +
 * classification) and the lenient ingest parser
 * (`knowledge/parse-lenient.ts`, plain-markdown-tolerant). Before this module
 * the frontmatter splitter, reserved-basename set, `basename`, and the
 * CodeQL-safe heading scanner were char-for-char duplicated between them.
 *
 * The parsers deliberately DIFFER on policy (is a missing frontmatter block an
 * error? is a missing `type` an error?) — that policy stays in each parser;
 * only the mechanics live here, expressed as a three-way split result so
 * neither policy is baked in.
 */

import * as yaml from "js-yaml";

/** Reserved OKF filenames — navigation/history, never concept documents. */
export const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

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

export function splitFrontmatterBlock(content: string): FrontmatterBlockSplit {
  if (!FRONTMATTER_OPEN.test(content)) return { kind: "none" };
  const afterOpen = content.replace(FRONTMATTER_OPEN, "");
  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { kind: "error", reason: "unterminated frontmatter block" };
  }
  const rawYaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length).replace(/^\r?\n/, "");

  // An empty frontmatter block (`---\n---`) is "no fields", not malformed.
  // Guard before `yaml.load` — js-yaml throws "input is empty" on a blank
  // document.
  if (rawYaml.trim() === "") {
    return { kind: "ok", data: null, body };
  }

  let data: unknown;
  try {
    data = yaml.load(rawYaml);
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
  if (typeof data !== "object" || Array.isArray(data)) {
    return { kind: "error", reason: "frontmatter is not a YAML mapping" };
  }
  return { kind: "ok", data: data as Record<string, unknown>, body };
}
