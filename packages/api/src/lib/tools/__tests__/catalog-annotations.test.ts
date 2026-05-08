/**
 * Catalog tool-annotations parity guard. The catalog-facing per-tool
 * description table at `apps/docs/content/docs/architecture/
 * mcp-tool-annotations.mdx` is a hand-curated, human-facing surface
 * that catalog reviewers (Claude Desktop directory, mcp.so, the public
 * MCP registry) read directly. It lives separately from the LLM-facing
 * `descriptions.ts` rubric audited in `description-rubric.test.ts` —
 * two surfaces, two readers — but the *list of tools* must stay in
 * lockstep. Drop a tool from `SEMANTIC_TOOL_NAMES` without removing
 * the row, or add a new typed tool without writing a row, and the next
 * catalog submission ships wrong copy.
 *
 * This test enforces:
 *   - Every name in `SEMANTIC_TOOL_NAMES` plus the legacy `explore`
 *     and `executeSQL` appears as a row in the table.
 *   - No row references a tool name that is *not* in that union (catches
 *     stale rows after a tool is dropped).
 *   - Every row stays under 140 characters so it doesn't wrap awkwardly
 *     in a constrained directory cell — the doc itself prescribes this
 *     limit.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SEMANTIC_TOOL_NAMES } from "../descriptions";

const ANNOTATIONS_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "apps",
  "docs",
  "content",
  "docs",
  "architecture",
  "mcp-tool-annotations.mdx",
);

const ROW_LIMIT_CHARS = 140;

interface CatalogRow {
  readonly tool: string;
  readonly description: string;
  readonly raw: string;
}

function parseCatalogRows(mdx: string): readonly CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const line of mdx.split("\n")) {
    // Skip the header (`| Tool | Catalog description |`) and the
    // separator (`| --- | --- |`). Match `| \`<name>\` | <desc> |`.
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/);
    if (!m) continue;
    rows.push({ tool: m[1], description: m[2], raw: line });
  }
  return rows;
}

describe("catalog tool-annotations parity", () => {
  const mdx = readFileSync(ANNOTATIONS_PATH, "utf8");
  const rows = parseCatalogRows(mdx);
  const expected = new Set<string>([
    ...SEMANTIC_TOOL_NAMES,
    "explore",
    "executeSQL",
  ]);

  it("contains a row for every tool in SEMANTIC_TOOL_NAMES + explore + executeSQL", () => {
    const present = new Set(rows.map((r) => r.tool));
    for (const tool of expected) {
      expect(present, `expected catalog row for \`${tool}\``).toContain(tool);
    }
  });

  it("does not reference any tool name outside the canonical set", () => {
    for (const row of rows) {
      expect(
        expected,
        `catalog row references unknown tool \`${row.tool}\` — drop the row or add the tool to SEMANTIC_TOOL_NAMES`,
      ).toContain(row.tool);
    }
  });

  it("keeps each description under the 140-char limit the doc itself prescribes", () => {
    for (const row of rows) {
      expect(
        row.description.length,
        `catalog description for \`${row.tool}\` is ${row.description.length} chars — trim to ≤${ROW_LIMIT_CHARS}`,
      ).toBeLessThanOrEqual(ROW_LIMIT_CHARS);
    }
  });
});
