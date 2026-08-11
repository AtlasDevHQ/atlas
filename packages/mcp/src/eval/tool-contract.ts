/**
 * What each MCP tool's result is CONTRACTED to look like, and how the eval
 * harnesses read one.
 *
 * ── Why this lives in `packages/mcp`, not beside its callers (#5135) ──
 *
 * The fact "`explore` answers in prose, everything else answers in JSON" is a
 * property of the **MCP surface**, not of either eval. It was previously spelled
 * in `packages/cli/bin/canonical-eval-mcp-llm.ts` and imported peer-to-peer by
 * `canonical-eval-tool-selection.ts` (`bin/ → bin/`), which put it out of reach
 * of the one thing that can hold it honest: the registered tool surface itself.
 *
 * Here it sits beside {@link extractToolJson} — the parse it exempts tools from
 * — and inside the package whose `registerTools` decides what the list must
 * name, so `packages/mcp/src/__tests__/tools.test.ts` can pin
 * {@link TEXT_CONTRACT_TOOLS} against a real `tools/list` in the REQUIRED suite.
 * That pin is the point of the move: {@link assertTextContractToolsPresent}
 * already anchored the list, but only at the boot of an eval run, and the
 * real-model lane is weekly and paid — so a rename's first signal was a wasted
 * paid run up to a week later.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  extractToolJson,
  joinTextContent,
  type ExtractedToolJson,
  type ToolListEntry,
} from "./client.js";

/**
 * What a tool's result is CONTRACTED to look like.
 *
 * - `"json"` — the tool answers with a JSON body (success) or an
 *   `AtlasMcpToolError` envelope (failure). Non-JSON from one of these is an
 *   MCP protocol regression and the grader fails the question for it.
 * - `"text"` — the tool's declared output is free-form text. `explore` is a
 *   sandboxed **shell**: `ls -la` answering with a directory listing is the
 *   contract being honoured, not broken.
 *
 * Resolved once per tool at bind time by {@link classifyToolContract} and
 * applied by {@link interpretResult}, which is where #5131 is actually closed.
 * The stamp on `RecordedToolCall` is the RECORD of that decision, not the
 * mechanism: `grade()`'s VERDICT is contract-blind (`isUnparseable` never sees
 * the field), and it reads `contract` only to choose which remedy an artifact
 * prints.
 */
export type ToolContract = "json" | "text";

/**
 * MCP tools whose declared output is free-form TEXT rather than JSON.
 *
 * ⚠️ THIS IS A NAME LIST, DELIBERATELY, AND THE ALTERNATIVES WERE MEASURED
 * RATHER THAN ASSUMED (#5131).
 *
 * 1. There is nothing on the wire to derive it from. `bindMcpToolsForLlm`
 *    classifies from {@link ToolListEntry}, which is `{ name, description?,
 *    inputSchema? }` — the `tools/list` response carries no statement about
 *    the shape of a tool's OUTPUT. Any "marker set at bind time" is therefore
 *    still computed from the name; a marker relocates this list, it cannot
 *    replace it.
 * 2. The one machine-readable candidate — MCP `outputSchema` — is provably
 *    unfaithful here. In `packages/mcp/src/semantic-tools.ts`, `listEntities`,
 *    `describeEntity` and `searchGlossary` all answer JSON and declare NO
 *    `outputSchema`; `runMetric` is the only one in that file that does.
 *    Exempting "no outputSchema" would exempt three of the four typed tools the
 *    protocol check exists to protect — it would disable the detector rather
 *    than sharpen it. `explore` declares none either, so the signal does not
 *    discriminate in EITHER direction. (Grep the registrations rather than
 *    trusting line numbers; an earlier draft of this note cited four and every
 *    one had drifted before the PR merged.)
 *
 * What a name list genuinely gets wrong is ROT: rename or drop `explore` and
 * the exemption silently stops matching, restoring the bug with no signal.
 * That is closed at TWO ranges, and the pair is the fix — not either alone:
 *
 *   - {@link assertTextContractToolsPresent}, called from inside both eval
 *     binders, anchors every name here against the surface that run actually
 *     discovered. Loud, and it sees the REAL hosted surface — but it fires at
 *     the boot of an eval run, and the real-model lane is weekly and paid.
 *   - `packages/mcp/src/__tests__/tools.test.ts` pins the same containment
 *     against a live `tools/list` off `registerTools`, in the REQUIRED suite —
 *     so a rename is red on the PR that lands it, before a paid run is spent.
 *     Narrower (native tools only, no plugin/datasource registrations) and
 *     therefore not a replacement for the boot anchor.
 *
 * Not by a TYPE, in either case, since both spellings of the type carry the
 * same string.
 *
 * ── Backend dependence: what the fix removes, and what it does not ───
 *
 * `explore` resolves to a different sandbox backend locally than on the CI
 * runner (`packages/api/src/lib/tools/backends/selection.ts`), which is how
 * #5131 stayed invisible across four local runs. The fix removes the dependence
 * on output SHAPE only. Three backend-sensitive paths remain, recorded rather
 * than papered over — each reaches the right verdict, but the backend has not
 * stopped mattering:
 *
 *   - **Latency.** The GRADER's `latencyMs` (`GradeInput`, not the per-dispatch
 *     `RecordedToolCall` field) is whole-question wall clock, so a slow sandbox
 *     cold start can trip the `baseline * 1.25` ceiling.
 *   - **Throttling.** `rate_limited` on `explore` can come from the sandbox
 *     backend OR the hosted quota; see `assertNotRateLimited`.
 *   - **Content.** A backend that lists the semantic layer and one that fails
 *     to start give the model different information to answer from. No grader
 *     change can remove this — the honest fix is pinning the eval's backend.
 */
export const TEXT_CONTRACT_TOOL_NAMES = ["explore"] as const;

/** Set form of {@link TEXT_CONTRACT_TOOL_NAMES}, for membership tests. */
export const TEXT_CONTRACT_TOOLS: ReadonlySet<string> = new Set(
  TEXT_CONTRACT_TOOL_NAMES,
);

/** Resolve a discovered tool's output contract. See {@link TEXT_CONTRACT_TOOLS}. */
export function classifyToolContract(name: string): ToolContract {
  return TEXT_CONTRACT_TOOLS.has(name) ? "text" : "json";
}

/**
 * Read one `tools/call` result according to the calling tool's contract.
 *
 * ⚠️ THE CONTRACT IS APPLIED HERE, AT THE RECORDING SEAM — NOT IN THE GRADER.
 * `grade()`'s protocol branch stays a plain `result.kind === "unparseable"`
 * test, so a future branch that reads `kind` directly cannot reopen #5131, and
 * a successful `ls` never wears the word "unparseable" in a failure artifact.
 *
 * For a `"json"` contract this is exactly {@link extractToolJson}. For a
 * `"text"` contract the tool's product IS its text, so a successful call is
 * recorded as `ok` carrying that text verbatim — including when the text
 * happens to parse as JSON (`wc -l` printing `3`), which otherwise makes the
 * SAME tool record under two different arms depending on what the directory
 * contained.
 *
 * Two cases stay in the `unparseable` (→ `protocol`) lane, and both are
 * regressions rather than shell output:
 *
 *   - **`isError` was flagged.** {@link extractToolJson} reaches its
 *     `unparseable` arm when no prefix of the text items parses, BEFORE it
 *     consults `isError`, so a server-flagged error with a prose body — what the
 *     MCP SDK's own `createToolError` emits for an uncaught throw — is
 *     indistinguishable from shell output by shape alone. Exempting it would
 *     turn #5131's loud false FAIL into a silent false PASS, with the model
 *     reading an internal error message as directory contents.
 *   - **No text content at all.** `explore` cannot produce this: it normalises
 *     a silent command to `"(no output)"`
 *     (`packages/api/src/lib/tools/explore.ts`), and every failure path returns
 *     an `Error:`-prefixed string. An empty `content` array is a protocol
 *     anomaly for every tool, whatever its output contract.
 */
export function interpretResult(
  result: CallToolResult,
  contract: ToolContract,
): ExtractedToolJson {
  if (contract !== "text") return extractToolJson(result);
  const text = joinTextContent(result);
  if (result.isError === true || text === "") {
    // Not shell output — fall back to the JSON reading so a typed envelope is
    // still recorded as `error`, and anything else stays `unparseable`.
    return extractToolJson(result);
  }
  return { kind: "ok", data: text };
}

/**
 * Fail the run when a declared text-contract tool is absent from the surface
 * the eval actually discovered.
 *
 * This is the anchor that makes {@link TEXT_CONTRACT_TOOLS} safe to spell as
 * names on the surface a run really talks to. Without it, renaming `explore`
 * (or dropping it from the hosted registration) turns the exemption into a
 * no-op and every successful shell call starts failing its question as
 * `protocol` again — the #5131 defect, back, with no diagnostic. Called against
 * the real `tools/list` result, so a rename is a loud stop at boot rather than
 * five silent mis-graded questions.
 */
export function assertTextContractToolsPresent(
  tools: readonly ToolListEntry[],
): void {
  const discovered = new Set(tools.map((t) => t.name));
  const missing = [...TEXT_CONTRACT_TOOLS].filter((n) => !discovered.has(n));
  if (missing.length === 0) return;
  throw new Error(
    `[harness] text-contract tool(s) not on the MCP surface: ${missing.join(", ")}. ` +
      `TEXT_CONTRACT_TOOLS exempts these from the JSON/protocol check because their ` +
      `declared output is free-form text; a name that no longer resolves means the ` +
      `exemption is dead and successful text output would be graded as a protocol ` +
      `regression (#5131). If the tool was RENAMED, point TEXT_CONTRACT_TOOLS at the ` +
      `new name. If it was deliberately REMOVED from this surface, delete the name — ` +
      `re-adding a dead one is the wrong repair. ` +
      `Discovered: ${
        discovered.size === 0
          ? "(empty — tools/list returned no tools)"
          : [...discovered].sort().join(", ")
      }`,
  );
}
