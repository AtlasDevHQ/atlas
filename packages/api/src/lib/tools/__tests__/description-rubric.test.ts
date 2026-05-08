/**
 * MCP tool description rubric — every typed tool exposed over MCP must
 * follow a fixed shape that drives reliable LLM tool selection. Drift
 * silently degrades routing (the LLM picks the wrong tool, returns the
 * wrong answer, blames the data). This test fails CI on regression so
 * any new tool opts into the rubric.
 *
 * Per-tool checks:
 *   - Long-form description is 80–150 words (LLMs weight verbose
 *     descriptions heavier than terse ones — keep all six in the same
 *     length band).
 *   - Contains a `Use this when …` directive (positive routing signal).
 *   - Contains a `Don't use this …` or `Avoid …` directive (pushes the
 *     LLM away from common wrong choices).
 *   - Contains at least one inline JSON example (call shape or response
 *     shape) so the LLM produces well-shaped calls.
 *   - The MCP-facing string (base + appended `Error contract:` section)
 *     surfaces the structured error envelope.
 *
 * The error-contract appendage is added by `withErrorContract` at MCP
 * registration time so the LLM sees it on the same description that
 * carries the rubric prose. See `apps/docs/content/docs/architecture/
 * mcp-tools.mdx` for the contributor-facing guide.
 */

import { describe, expect, it } from "bun:test";

import type { AtlasMcpToolErrorCode } from "@useatlas/types/mcp";

import {
  DESCRIBE_ENTITY_ERROR_CODES,
  DESCRIBE_ENTITY_TOOL_DESCRIPTION,
  EXECUTE_SQL_ERROR_CODES,
  EXECUTE_SQL_TOOL_DESCRIPTION,
  EXPLORE_ERROR_CODES,
  EXPLORE_TOOL_DESCRIPTION,
  LIST_ENTITIES_ERROR_CODES,
  LIST_ENTITIES_TOOL_DESCRIPTION,
  RUN_METRIC_ERROR_CODES,
  RUN_METRIC_TOOL_DESCRIPTION,
  SEARCH_GLOSSARY_ERROR_CODES,
  SEARCH_GLOSSARY_TOOL_DESCRIPTION,
  withErrorContract,
} from "../descriptions";

const MIN_WORDS = 80;
const MAX_WORDS = 150;

// A `{ …"key": value… }` block whose key is one of the recognized tool
// arg / response keys we ship today. Without the key whitelist, a stub
// like `{ "x": 0 }` would satisfy "inline JSON example" while telling
// the LLM nothing useful about the call shape — the audit's whole point
// is that the example must reflect a real call. Adding a new tool means
// extending this list when its primary arg/result key is new.
const RECOGNIZED_EXAMPLE_KEYS = [
  "command", // explore
  "sql", // executeSQL
  "explanation", // executeSQL
  "filter", // listEntities
  "name", // describeEntity / response shape
  "entity", // describeEntity response
  "term", // searchGlossary
  "id", // runMetric
  "value", // runMetric response
  "matches", // searchGlossary response
  "entities", // listEntities response
  "count", // listEntities / searchGlossary response
] as const;
const JSON_EXAMPLE_RE = new RegExp(
  `\\{[^{}]*"(?:${RECOGNIZED_EXAMPLE_KEYS.join("|")})"\\s*:[^{}]+\\}`,
);

interface ToolUnderRubric {
  readonly name: string;
  readonly base: string;
  readonly codes: readonly AtlasMcpToolErrorCode[];
}

const TOOLS: readonly ToolUnderRubric[] = [
  { name: "explore", base: EXPLORE_TOOL_DESCRIPTION, codes: EXPLORE_ERROR_CODES },
  { name: "executeSQL", base: EXECUTE_SQL_TOOL_DESCRIPTION, codes: EXECUTE_SQL_ERROR_CODES },
  { name: "listEntities", base: LIST_ENTITIES_TOOL_DESCRIPTION, codes: LIST_ENTITIES_ERROR_CODES },
  { name: "describeEntity", base: DESCRIBE_ENTITY_TOOL_DESCRIPTION, codes: DESCRIBE_ENTITY_ERROR_CODES },
  { name: "searchGlossary", base: SEARCH_GLOSSARY_TOOL_DESCRIPTION, codes: SEARCH_GLOSSARY_ERROR_CODES },
  { name: "runMetric", base: RUN_METRIC_TOOL_DESCRIPTION, codes: RUN_METRIC_ERROR_CODES },
];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe("MCP tool description rubric", () => {
  it("covers every typed MCP tool", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "describeEntity",
      "executeSQL",
      "explore",
      "listEntities",
      "runMetric",
      "searchGlossary",
    ]);
  });

  for (const tool of TOOLS) {
    describe(tool.name, () => {
      it(`base description word count is in [${MIN_WORDS}, ${MAX_WORDS}]`, () => {
        const count = wordCount(tool.base);
        expect(
          count,
          `${tool.name} base description has ${count} words; rubric requires ${MIN_WORDS}–${MAX_WORDS}.`,
        ).toBeGreaterThanOrEqual(MIN_WORDS);
        expect(
          count,
          `${tool.name} base description has ${count} words; rubric requires ${MIN_WORDS}–${MAX_WORDS}.`,
        ).toBeLessThanOrEqual(MAX_WORDS);
      });

      it("contains a 'Use this when' directive", () => {
        expect(
          tool.base.includes("Use this when"),
          `${tool.name} description must contain 'Use this when …' so the LLM has a positive routing anchor.`,
        ).toBe(true);
      });

      it("contains a 'Don't use this' or 'Avoid' directive", () => {
        const has = tool.base.includes("Don't use this") || tool.base.includes("Avoid");
        expect(
          has,
          `${tool.name} description must contain 'Don't use this …' or 'Avoid …' so the LLM has an explicit anti-routing anchor.`,
        ).toBe(true);
      });

      it("contains at least one inline JSON example", () => {
        expect(
          JSON_EXAMPLE_RE.test(tool.base),
          `${tool.name} description must include a JSON example (call shape or response shape, e.g. '{ "id": "metric_id" }').`,
        ).toBe(true);
      });

      it("MCP-facing description ends with the structured 'Error contract:' section", () => {
        const full = withErrorContract(tool.base, tool.codes);
        expect(full).toContain("Error contract:");
        // The error-contract section must come AFTER the rubric prose so
        // the LLM reads purpose → recovery in order, never recovery first.
        const baseLength = tool.base.length;
        expect(full.indexOf("Error contract:"), `${tool.name}: 'Error contract:' must appear after the base description.`).toBeGreaterThan(baseLength - 1);
      });
    });
  }
});
