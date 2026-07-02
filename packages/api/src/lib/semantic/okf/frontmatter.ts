/**
 * OKF frontmatter split/parse/serialize (#4140 spike).
 *
 * OKF conformance requires every non-reserved `.md` file to carry parseable
 * YAML frontmatter with a non-empty `type`. Parsing failures are surfaced to
 * the caller as typed results, so malformed files land in the mapping report
 * (never silently dropped) while the rest of the bundle still imports.
 */

import * as yaml from "js-yaml";
import type { OkfFrontmatter, ParsedFrontmatter } from "./types";

const FRONTMATTER_OPEN = /^---\r?\n/;

export interface ParsedDocument {
  frontmatter: ParsedFrontmatter;
  body: string;
}

export type FrontmatterResult =
  | { ok: true; doc: ParsedDocument }
  | { ok: false; reason: string };

/**
 * Split a markdown document into YAML frontmatter + body.
 *
 * Returns a typed failure (not a throw) for missing/unparseable frontmatter
 * or a missing `type` — importers collect these into the mapping report.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  if (!FRONTMATTER_OPEN.test(content)) {
    return { ok: false, reason: "no YAML frontmatter block" };
  }
  const afterOpen = content.replace(FRONTMATTER_OPEN, "");
  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { ok: false, reason: "unterminated frontmatter block" };
  }
  const rawYaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen
    .slice(closeMatch.index + closeMatch[0].length)
    .replace(/^\r?\n/, "");

  let data: unknown;
  try {
    data = yaml.load(rawYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `frontmatter YAML parse error: ${msg}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter is not a YAML mapping" };
  }
  const record = data as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || type.trim() === "") {
    // OKF conformance: `type` is the one required key.
    return { ok: false, reason: "frontmatter missing required non-empty `type`" };
  }
  return {
    ok: true,
    doc: { frontmatter: { ...record, type }, body },
  };
}

/** Serialize frontmatter + body back into an OKF concept document. */
export function serializeDocument(
  frontmatter: OkfFrontmatter,
  body: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: 120, noRefs: true });
  return `---\n${fm}---\n\n${body.trimEnd()}\n`;
}
