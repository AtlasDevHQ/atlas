/**
 * MCP tool description rubric — every typed tool exposed over MCP must
 * follow a fixed shape that drives reliable LLM tool selection. Drift
 * silently degrades routing (the LLM picks the wrong tool, returns the
 * wrong answer, blames the data). This test fails CI on regression so
 * any new tool opts into the rubric.
 *
 * Per-tool checks:
 *   - Long-form description is 80–150 words of the tool's OWN prose, and the
 *     COMPOSED string (own prose + any shared interpolation, still excluding
 *     the `Error contract:` appendage) stays under the
 *     composed ceiling (LLMs weight verbose descriptions heavier than terse
 *     ones — keep every tool in the same length band). Shared interpolated
 *     constants are excluded from the per-tool budget and carry their own;
 *     see the decoupling note on `SHARED_INTERPOLATIONS` below.
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
 * carries the rubric prose. See `apps/docs/content/shared/architecture/
 * mcp-tools.mdx` for the contributor-facing guide.
 */

import { describe, expect, it } from "bun:test";

import type { AtlasMcpToolErrorCode } from "@useatlas/types/mcp";

import { KNOWLEDGE_TRUST_FRAMING } from "../../knowledge/framing";
import {
  DESCRIBE_ENTITY_ERROR_CODES,
  DESCRIBE_ENTITY_TOOL_DESCRIPTION,
  EXECUTE_SQL_ERROR_CODES,
  EXECUTE_SQL_TOOL_DESCRIPTION,
  EXPLORE_ERROR_CODES,
  EXPLORE_TOOL_DESCRIPTION,
  LIST_ENTITIES_ERROR_CODES,
  LIST_ENTITIES_TOOL_DESCRIPTION,
  QUERY_ERROR_CODES,
  QUERY_TOOL_DESCRIPTION,
  RUN_METRIC_ERROR_CODES,
  RUN_METRIC_TOOL_DESCRIPTION,
  SEARCH_BRAIN_ERROR_CODES,
  SEARCH_BRAIN_TOOL_DESCRIPTION,
  SEARCH_GLOSSARY_ERROR_CODES,
  SEARCH_GLOSSARY_TOOL_DESCRIPTION,
  withErrorContract,
} from "../descriptions";

const MIN_WORDS = 80;
const MAX_WORDS = 150;

/**
 * The shared-constant budget, decoupled from the per-tool one (#4954).
 *
 * `KNOWLEDGE_TRUST_FRAMING` is authored ONCE and interpolated into two of the
 * descriptions measured below. While its words were billed to each
 * interpolating tool's independent 80–150 budget, the budget was not a
 * per-tool property at all: `searchBrain` sat at 148/150 and `explore` at
 * 149/150, so adding three words to the SHARED constant failed the gate for
 * both tools at once — and the failure named the tools, not the constant, so
 * an author who had touched neither description was sent to trim prose that
 * was not the cause.
 *
 * Resolution: the per-tool budget measures the tool's OWN prose, and the
 * shared constant carries its own explicitly-named ceiling here. Growing the
 * shared constant now fails ONE test that says so, instead of silently
 * spending headroom in every description that interpolates it.
 *
 * The string an LLM actually reads is still bounded, but by a DIFFERENT
 * number and by its own assertion: `composed word count` below caps the total
 * at {@link COMPOSED_CEILING}. That arm is not redundant
 * arithmetic — `authoredWordCount` removes EVERY occurrence and nothing caps
 * how many there are, so without it a description interpolating the constant
 * six times clears every authored budget at up to 180 composed words (150 + 6x5).
 *
 * `interpolatedInto` is not documentation: `is actually interpolated` asserts
 * it, because the removal below is a silent no-op if the constant ever
 * stops appearing verbatim in a description (reworded, wrapped, split). That
 * no-op would restore the exact coupling this decoupling removes, with nothing
 * red to say so.
 *
 * 8 rather than the 5 the constant measures today: three words of deliberate
 * slack, so a wording fix to the constant does not need a budget edit in the
 * same commit, while a rewrite past 8 words does.
 */
const MAX_SHARED_WORDS = 8;

const SHARED_INTERPOLATIONS = [
  {
    name: "KNOWLEDGE_TRUST_FRAMING",
    text: KNOWLEDGE_TRUST_FRAMING,
    interpolatedInto: ["explore", "searchBrain"],
  },
] as const;

/**
 * Derived from the registry rather than written as `MAX_WORDS + 8`, so adding
 * a second shared constant widens the composed ceiling by exactly its budget
 * instead of silently squeezing every interpolating tool's own prose.
 * One occurrence of each constant is the allowance; a description that
 * interpolates one twice pays for the second out of its own budget.
 *
 * The slack is real and worth knowing: for the shorter of the two, searchBrain
 * at 148 composed, a SECOND and THIRD interpolation of the 5-word constant
 * still fit (153, 158) and the fourth trips this; `explore` at 149 trips one
 * earlier. It bounds runaway repetition, not a single duplicate.
 */
const COMPOSED_CEILING = MAX_WORDS + SHARED_INTERPOLATIONS.length * MAX_SHARED_WORDS;

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
  "question", // query
  "answer", // query response
  "query", // searchBrain
  "limit", // searchBrain
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
  { name: "query", base: QUERY_TOOL_DESCRIPTION, codes: QUERY_ERROR_CODES },
  { name: "searchBrain", base: SEARCH_BRAIN_TOOL_DESCRIPTION, codes: SEARCH_BRAIN_ERROR_CODES },
];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Words the tool's author is accountable for: the description with every
 * occurrence of a shared interpolated constant removed.
 *
 * Removal-then-recount, NOT `wordCount(text) - wordCount(constant)`. The
 * subtraction looks tidier and is wrong wherever the interpolation abuts
 * punctuation — which is both RUBRIC-MEASURED call sites (`lib/knowledge/mirror.ts`
 * interpolates it too, into a string this rubric does not measure):
 * `${…FRAMING}, never queryable`
 * and `${…FRAMING}.`. There the constant's last word absorbs the author's
 * comma or period into one token, so the constant contributes five tokens but
 * the author's own text loses only four when it goes, and subtracting five
 * hands the author a free word. Silent, and permissive, which is the direction
 * nobody notices.
 *
 * Removal has no such precondition: what is left IS the author's prose, glued
 * boundaries and stranded punctuation included, so the count is CONSERVATIVE
 * by construction rather than resting on a spacing rule a future edit could
 * quietly violate. Conservative, not exact — the stranded `,` or `.` is left
 * behind as a token of its own, so the author is over-charged by one per
 * interpolation THAT ABUTS PUNCTUATION — which is both of today's sites
 * (searchBrain reads 144, where a clean subtraction would say 143). A
 * space-surrounded interpolation costs nothing extra. Erring toward charging the author is the safe direction; erring the
 * other way is the free word this replaced.
 */
function authoredWordCount(text: string): number {
  let stripped = text;
  for (const shared of SHARED_INTERPOLATIONS) {
    stripped = stripped.split(shared.text).join(" ");
  }
  return wordCount(stripped);
}

describe("MCP tool description rubric", () => {
  it("covers every typed MCP tool", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "describeEntity",
      "executeSQL",
      "explore",
      "listEntities",
      "query",
      "runMetric",
      "searchBrain",
      "searchGlossary",
    ]);
  });

  for (const tool of TOOLS) {
    describe(tool.name, () => {
      it(`authored word count is in [${MIN_WORDS}, ${MAX_WORDS}]`, () => {
        const count = authoredWordCount(tool.base);
        const detail = `${tool.name} base description has ${count} authored words (shared interpolated constants excluded — they carry their own budget); rubric requires ${MIN_WORDS}–${MAX_WORDS}.`;
        expect(count, detail).toBeGreaterThanOrEqual(MIN_WORDS);
        expect(count, detail).toBeLessThanOrEqual(MAX_WORDS);
      });

      it(`composed word count is within the ceiling of ${COMPOSED_CEILING}`, () => {
        // The bound on the base string as composed, as opposed to the slice of
        // it its author is charged for. (Still the BASE — the `Error contract:`
        // appendage `withErrorContract` adds at registration is outside every
        // budget in this file, as the header says.)
        //
        // NOT implied by the two budgets above: `authoredWordCount` removes
        // EVERY occurrence and nothing caps occurrences, so a description
        // interpolating the shared constant six times clears every authored
        // budget at up to 180 composed words — the rubric's own premise
        // (comparable weight across tools) quietly abandoned. Decoupling was
        // meant to change who gets BLAMED, not what is bounded.
        const count = wordCount(tool.base);
        expect(
          count,
          `${tool.name}'s composed description is ${count} words, over the ceiling of ${COMPOSED_CEILING} (${MAX_WORDS} own prose + ${MAX_SHARED_WORDS} for each of the ${SHARED_INTERPOLATIONS.length} shared interpolation(s)). Trim this tool's own clauses or drop a repeated interpolation — each shared constant has its own named test and is not the thing to cut here.`,
        ).toBeLessThanOrEqual(COMPOSED_CEILING);
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

/**
 * The shared-constant half of the budget (#4954).
 *
 * These are the tests that make the decoupling above safe rather than a hole:
 * the per-tool budget no longer charges for a shared constant, so the constant
 * needs a ceiling of its own, and the exclusion needs to be provably live.
 */
describe("MCP tool description rubric — shared interpolated constants", () => {
  for (const shared of SHARED_INTERPOLATIONS) {
    describe(shared.name, () => {
      it(`fits its own budget of ${MAX_SHARED_WORDS} words`, () => {
        const count = wordCount(shared.text);
        expect(
          count,
          `${shared.name} is ${count} words, over its ${MAX_SHARED_WORDS}-word budget. It is interpolated into ${shared.interpolatedInto.length} rubric-measured tool descriptions (${shared.interpolatedInto.join(", ")}) — plus non-rubric agent surfaces this test cannot see, listed on the constant itself in lib/knowledge/framing.ts — so every word here is spent on every one of them. Raise MAX_SHARED_WORDS deliberately or tighten the constant — do NOT trim an unrelated tool's prose to pay for it.`,
        ).toBeLessThanOrEqual(MAX_SHARED_WORDS);
      });

      it("is actually interpolated into every description it is excluded from", () => {
        // Without this, `authoredWordCount`'s removal is a silent no-op:
        // reword the constant, or wrap it so it no longer appears verbatim,
        // and every interpolating tool is quietly back on the coupled budget
        // with nothing red to say so.
        for (const name of shared.interpolatedInto) {
          const tool = TOOLS.find((t) => t.name === name);
          expect(tool, `${shared.name} claims to be interpolated into an unknown tool '${name}'`).toBeDefined();
          expect(
            tool?.base.includes(shared.text),
            `${name}'s description no longer contains ${shared.name} verbatim, so excluding it from ${name}'s budget silently removes nothing. Re-interpolate it, or drop '${name}' from its interpolatedInto list.`,
          ).toBe(true);
        }
      });

      it("is not interpolated anywhere the exclusion was never declared", () => {
        // The other direction. `authoredWordCount` matches on TEXT, not on
        // this list, so a new description that interpolates the constant gets
        // the discount whether or not it is declared here — and the budget
        // failure above would then under-report which tools a growing constant
        // costs, which is the one thing that message exists to get right.
        const declared = new Set<string>(shared.interpolatedInto);
        const undeclared = TOOLS.filter(
          (t) => t.base.includes(shared.text) && !declared.has(t.name),
        ).map((t) => t.name);
        expect(
          undeclared,
          `these tool descriptions interpolate ${shared.name} but are not listed in its interpolatedInto: ${undeclared.join(", ")}. Add them, so the budget failure can name every tool the constant costs.`,
        ).toEqual([]);
      });
    });
  }
});

// ── Plugin-contributed tools (#2078) ────────────────────────────────────
//
// Plugin MCP tools share the same rubric as native tools. The host
// rebuilds the LLM-facing description via `withErrorContract` at boot
// using the same helper that drives the native pass above, so any
// regression in a plugin's prose fails CI here. Iterating
// `pluginMcpToolRegistry.getAll()` is intentional — every registered
// plugin tool is checked, so adding a new tool to a plugin is a
// rubric-coverage opt-in by default.
//
// We register the canonical reference plugin (`@useatlas/yaml-context`)
// at the top of the suite so the singleton is non-empty when the
// per-tool checks run. Tests can register additional plugin tools
// before this suite runs to expand coverage; the singleton is shared
// across the @atlas/api test process.

import { contextYamlPlugin } from "@useatlas/yaml-context";
import { PluginMcpToolRegistry } from "../../plugins/mcp-tools";

describe("MCP tool description rubric — plugin-contributed tools", () => {
  const registry = new PluginMcpToolRegistry();
  const yamlContext = contextYamlPlugin();
  for (const tool of yamlContext.mcpTools?.() ?? []) {
    registry.register(yamlContext.id, tool);
  }

  const pluginTools = registry.getAll();

  it("at least one plugin tool is registered (yaml-context reference)", () => {
    expect(
      pluginTools.length,
      "No plugin MCP tools registered — yaml-context.getYamlContextStats should be present as the reference implementation",
    ).toBeGreaterThan(0);
  });

  for (const tool of pluginTools) {
    describe(tool.qualifiedName, () => {
      it(`base description word count is in [${MIN_WORDS}, ${MAX_WORDS}]`, () => {
        // `wordCount`, not `authoredWordCount` (#4954): the shared-constant
        // exclusion is scoped to native descriptions, which DECLARE which
        // constants they interpolate. A plugin cannot make that declaration —
        // it is a third party — so a plugin string that happened to contain
        // the same phrase would get a discount nobody recorded.
        const count = wordCount(tool.description);
        expect(
          count,
          `${tool.qualifiedName} base description has ${count} words; rubric requires ${MIN_WORDS}–${MAX_WORDS}.`,
        ).toBeGreaterThanOrEqual(MIN_WORDS);
        expect(
          count,
          `${tool.qualifiedName} base description has ${count} words; rubric requires ${MIN_WORDS}–${MAX_WORDS}.`,
        ).toBeLessThanOrEqual(MAX_WORDS);
      });

      it("contains a 'Use this when' directive", () => {
        expect(
          tool.description.includes("Use this when"),
          `${tool.qualifiedName} description must contain 'Use this when …'.`,
        ).toBe(true);
      });

      it("contains a 'Don't use this' or 'Avoid' directive", () => {
        const has =
          tool.description.includes("Don't use this") ||
          tool.description.includes("Avoid");
        expect(
          has,
          `${tool.qualifiedName} description must contain 'Don't use this …' or 'Avoid …'.`,
        ).toBe(true);
      });

      it("contains at least one inline JSON example", () => {
        // Plugin tools may use any reasonable arg/response key — accept
        // any `{...key: value...}` block, since the native-tool key
        // whitelist would be too restrictive across the plugin
        // ecosystem.
        const hasJsonBlock = /\{[^{}]*"[^"]+"\s*:[^{}]+\}/.test(tool.description);
        expect(
          hasJsonBlock,
          `${tool.qualifiedName} description must include a JSON example (call shape or response shape).`,
        ).toBe(true);
      });

      it("appended via withErrorContract surfaces the error envelope contract", () => {
        const codes =
          tool.errorCodes && tool.errorCodes.length > 0
            ? (tool.errorCodes as readonly AtlasMcpToolErrorCode[])
            : (["validation_failed", "internal_error"] as const);
        const full = withErrorContract(tool.description, codes);
        expect(full).toContain("Error contract:");
        expect(full.indexOf("Error contract:")).toBeGreaterThan(
          tool.description.length - 1,
        );
      });
    });
  }
});
