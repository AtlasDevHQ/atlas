/**
 * The ONE `searchBrain` input schema (#4954).
 *
 * Both agent surfaces read this module: the AI SDK tool in
 * `lib/tools/search-brain.ts` wraps {@link SEARCH_BRAIN_INPUT_SHAPE} in a
 * `z.object`, and the MCP tool in `packages/mcp/src/tools.ts` hands the raw
 * shape straight to `registerTool` (the MCP SDK takes a `ZodRawShape`, the AI
 * SDK takes a `ZodObject` — the only reason both spellings are exported).
 *
 * ## Why this is its own module and not a `search-brain.ts` export
 *
 * The load-bearing property is not that this module is small — it is that
 * **the MCP suite does not `mock.module` it.**
 * `packages/mcp/src/__tests__/tools.test.ts` mocks
 * `@atlas/api/lib/tools/search-brain` wholesale, so that it can stub
 * `execute`. Argument prose exported from there would reach `listTools()` as
 * the STUB, and that suite's two #4954 pins — the registration-identity one
 * and the served-value one — would compare a stub against a stub. Both sides
 * read the same import, so a stub is the one edit that turns them green
 * without anything being right. That property has to survive someone later
 * adding an import here, so state it as the invariant rather than as "leaf
 * module": this file may grow dependencies, but neither it NOR ANYTHING IT
 * IMPORTS may become one of the modules that suite stubs. That is not
 * theoretical — the `limit` and `include` prose interpolate constants from
 * `lib/brain/search` and `@useatlas/schemas`, so a stub of either would blank
 * those two descriptions on BOTH sides of the value pin and leave it green
 * while clients are served "max undefined". (CLAUDE.md's mock-all-exports rule makes the
 * mistake likely rather than exotic — a maintainer adding an export here and
 * dutifully stubbing it there is all it takes.)
 *
 * ## Why the duplication was worth deleting
 *
 * Until #4954 the shape was declared twice with independently authored
 * `.describe()` prose, kept in agreement only by a test on each side plus a
 * hand-mirrored copy of each rule. Both correctness bugs that arrangement
 * produced landed on `asOf`: an unqualified "retracted never" (#4933) and a
 * dropped `include` precondition (#4939), each of which then had to be fixed
 * TWICE, once per copy. `query` drifted too, harmlessly.
 *
 * So by the base commit both copies already carried both clauses — the
 * duplication that remained was structural, not a live defect. Every argument
 * below is the api-side spelling, the surface those fixes were authored
 * against, which leaves that surface byte-identical. The MCP surface changes
 * mostly in verbosity, with two deltas worth naming. `asOf` GAINS the
 * `non-ISO forms` rejection case (which `parseBrainAsOf` does enforce) and
 * the `later-superseded` qualifier, neither of which its copy ever carried.
 * `query` LOSES the trust-tier adjectives "reviewed" and "raw" — not a
 * verbosity trim, but nothing becomes unsayable: the tool description MCP is
 * served labels all three tiers already.
 *
 * ## Two exports, and what they are not for
 *
 * The raw shape and the assembled object exist because the two SDKs want
 * different spellings, and the object is BUILT from the shape so they cannot
 * be edited apart. Neither is a general-purpose building block: a third
 * consumer re-assembling its own `z.object(SHAPE).strict()` would diverge in
 * BEHAVIOUR while passing every pin that guards these exports — none of them
 * observes a third consumer's own assembly. Register one of these two, or add
 * a pin alongside them.
 *
 * ## Why `packages/mcp` imports `zod/v4` and this file imports `zod`
 *
 * Not an oversight, and not the peer-differentiated nominal-clash trap: both
 * packages resolve one `zod@4.4.3`, whose root entry re-exports the v4
 * classic namespace, and the MCP SDK types `registerTool` against its own
 * structural `Record<string, AnySchema>` rather than zod's nominal classes.
 * Unifying the two spellings is a no-op; don't do it as a "cleanup" on the
 * assumption it is currently broken.
 *
 * ## What still lives elsewhere
 *
 * The TOOL description (not the arguments) is `SEARCH_BRAIN_TOOL_DESCRIPTION`
 * in `lib/tools/descriptions.ts`, already single-sourced — MCP derives it from
 * `searchBrain.description` via `withErrorContract`. The system-prompt
 * guidance block is `SEARCH_BRAIN_DESCRIPTION` in `lib/tools/search-brain.ts`,
 * a genuinely different string for a different reader.
 */

import { z } from "zod";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "@atlas/api/lib/brain/search";
import { BRAIN_RESULT_TIERS } from "@useatlas/schemas";

/**
 * The raw shape, for the MCP SDK's `registerTool({ inputSchema })`, which
 * takes a `ZodRawShape` rather than an assembled object.
 *
 * The `asOf` prose is the correctness-bearing entry and carries two clauses
 * that read as decoration and are not:
 *
 *   - **"never as a RESULT, only as a `tensions` counterpart labelled by
 *     `invalidatedAt`"** (#4933). A retracted fact IS still reachable — #4913
 *     keeps it in `tensions` on purpose so a settled retraction stays
 *     distinguishable from a live rival. An unqualified "retracted never"
 *     here teaches the model to report a settled retraction as a live
 *     contradiction.
 *   - **"Requires the fact store in `include`"** (#4939). Not advisory:
 *     `searchBrainCore` HARD-REFUSES an `asOf` read whose `include` omits
 *     facts, validated before any store runs. Unstated, it is a refusal a
 *     well-behaved caller cannot avoid.
 *
 * Both rules are asserted against this module in
 * `__tests__/search-brain-tool.test.ts`; the MCP suite asserts only that the
 * schema it serves IS this one.
 *
 * `limit` and `include` are the two arguments whose VALUES the SDK rejects
 * before the tool body ever sees them, and that is worth knowing before
 * anyone copies the pattern onto a sibling. The MCP SDK validates
 * `inputSchema` first, so `limit: 0` or an unrecognized `include` tier comes
 * back as a bare `isError` tool result carrying the SDK's own validation
 * text — NOT the `{ code, message, request_id }` envelope every runtime
 * refusal here returns, because it never reaches `dispatch()`. (It is a
 * resolved result, not a transport-level failure; `callTool` does not
 * reject.) A side effect worth noting: `normalizeSearchInput`'s
 * drop-unrecognized-`include`-and-log path is therefore unreachable for any
 * caller that went through zod, and exists for the ones that did not.
 *
 * Both bounds are kept anyway, because rejecting is more honest than
 * `normalizeSearchInput`'s clamp silently turning `limit: 500` into 50, and
 * the descriptions state the cap and the tier list so a well-behaved model
 * never trips either. Do NOT "fix" `asOf` the same way by adding a format
 * constraint: it is deliberately a bare `z.string()` so `parseBrainAsOf` can
 * refuse it with a logged, id-carrying `validation_failed` naming the
 * offending value (#4916).
 *
 * `satisfies z.ZodRawShape` reports a non-zod entry HERE rather than at
 * whichever package imports it. `Object.freeze` blocks a RE-POINTED key —
 * the object is aliased by reference into two registrars in one process, so
 * a reassignment from either would silently rewrite both surfaces and stay
 * deep-equal to itself. It is shallow: it cannot stop someone mutating a zod
 * node in place, which is part of why the served-value pin exists.
 */
export const SEARCH_BRAIN_INPUT_SHAPE = Object.freeze({
  query: z
    .string()
    .optional()
    .describe(
      "Free-text search across claims, source records, and document bodies. Omit to browse the most recent entries in each store.",
    ),
  include: z
    .array(z.enum(BRAIN_RESULT_TIERS))
    .optional()
    .describe(
      `Restrict to specific result classes (${BRAIN_RESULT_TIERS.join(", ")}). Omit to search all three.`,
    ),
  type: z.string().optional().describe("Documents only: filter to one OKF document type, e.g. 'Runbook'."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Documents only: filter to documents carrying ALL of these OKF tags."),
  collection: z
    .string()
    .optional()
    .describe("Documents only: restrict to a single knowledge collection (install slug)."),
  since: z
    .string()
    .optional()
    .describe("Documents only: ISO-8601 date; documents at or after this timestamp."),
  asOf: z
    .string()
    .optional()
    .describe(
      "Facts only: historical point read — returns the reviewed facts valid at that moment (later-superseded versions included; a retracted fact never as a RESULT, only as a `tensions` counterpart labelled by `invalidatedAt`). An ISO-8601 date (2026-07-27) or a timestamp with an EXPLICIT zone (2026-07-27T09:00:00Z); zone-less times, non-ISO forms, and future instants are rejected. Requires the fact store — `attested` — in `include`. Omit for current beliefs.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`Max fused results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
  expand: z
    .boolean()
    .optional()
    .describe("Include 1-hop linked neighbors of the matched documents (default true)."),
} satisfies z.ZodRawShape);

/**
 * The assembled object, for the AI SDK's `tool({ inputSchema })`.
 *
 * Built FROM {@link SEARCH_BRAIN_INPUT_SHAPE} rather than declared alongside
 * it, so the two spellings cannot be edited apart.
 */
export const searchBrainInputSchema = z.object(SEARCH_BRAIN_INPUT_SHAPE);
