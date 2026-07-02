/**
 * OKF frontmatter split/parse/serialize (#4140 spike).
 *
 * OKF conformance requires every non-reserved `.md` file to carry parseable
 * YAML frontmatter with a non-empty `type`. Parsing failures are surfaced to
 * the caller as typed results, so malformed files land in the mapping report
 * (never silently dropped) while the rest of the bundle still imports.
 */

import * as yaml from "js-yaml";
import { splitFrontmatterBlock } from "./md-utils";
import type { OkfFrontmatter, ParsedFrontmatter } from "./types";

export interface ParsedDocument {
  frontmatter: ParsedFrontmatter;
  body: string;
}

export type FrontmatterResult =
  | { ok: true; doc: ParsedDocument }
  | { ok: false; reason: string };

/**
 * Split a markdown document into YAML frontmatter + body — the STRICT
 * (conformance) policy over the shared mechanical splitter (`./md-utils`):
 * a missing block, an empty block, and a missing `type` are all failures.
 *
 * Returns a typed failure (not a throw) — importers collect these into the
 * mapping report.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const split = splitFrontmatterBlock(content);
  if (split.kind === "none") {
    return { ok: false, reason: "no YAML frontmatter block" };
  }
  if (split.kind === "error") {
    return { ok: false, reason: split.reason };
  }
  // An empty block carries no `type` — same conformance failure as any other
  // non-mapping frontmatter.
  if (split.data === null) {
    return { ok: false, reason: "frontmatter is not a YAML mapping" };
  }
  const record = split.data;
  const type = record.type;
  if (typeof type !== "string" || type.trim() === "") {
    // OKF conformance: `type` is the one required key.
    return { ok: false, reason: "frontmatter missing required non-empty `type`" };
  }
  return {
    ok: true,
    doc: { frontmatter: { ...record, type }, body: split.body },
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
