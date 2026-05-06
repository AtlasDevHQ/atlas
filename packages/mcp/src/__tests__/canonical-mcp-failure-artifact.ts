/**
 * Structured failure artifact for the MCP-path canonical eval (#2074).
 *
 * Every failed question produces one artifact: the wire frame the eval
 * sent, the response we got back, the response we expected, and a
 * machine-readable category so a future reader (human or LLM) can
 * reason about the regression without re-running the eval.
 *
 * Categories:
 *   - `protocol`        wire shape changed (missing fields, wrong content[]
 *                       layout, isError on a success path, etc.)
 *   - `tool_selection`  the LLM picked the wrong tool (only meaningful in
 *                       --mcp-llm; emitted by Phase 2)
 *   - `recovery`        an `ambiguous_term` envelope came back without
 *                       possible_mappings, an `unknown_metric` came back
 *                       without a `hint`, etc.
 *   - `latency`         frame round-trip exceeded the baseline by >25%
 *   - `assertion`       eval-level assertion failed (row count, sql_pattern,
 *                       non_zero, expected status). The most common case.
 */

export type FailureCategory =
  | "protocol"
  | "tool_selection"
  | "recovery"
  | "latency"
  | "assertion";

export interface McpFailureArtifact {
  readonly questionId: string;
  readonly category: FailureCategory;
  /** Tool name dispatched, or `null` for non-tool dispatches (prompts/list). */
  readonly tool: string | null;
  /** Args passed to the tool (or empty for prompts/list). */
  readonly args: Readonly<Record<string, unknown>>;
  /** Round-trip latency in milliseconds — useful for trend tracking. */
  readonly latencyMs: number;
  /** Response we got back — already parsed from JSON when possible. */
  readonly response: unknown;
  /** What the eval expected. Free-form per category. */
  readonly expected: unknown;
  /** One-line human summary. Goes into the printed eval log. */
  readonly summary: string;
}

/**
 * Format a single artifact as a multi-line block. Rendered into the eval
 * log so a CI failure carries enough context to act on without rerunning.
 * The diff is intentionally a JSON dump rather than a unified-diff —
 * callers can pipe through `jq` / a diff tool of choice.
 */
export function formatArtifact(a: McpFailureArtifact): string {
  const lines: string[] = [];
  lines.push(`-- ${a.questionId} [${a.category}] ${a.summary}`);
  lines.push(`   tool: ${a.tool ?? "<none>"}  latency: ${a.latencyMs}ms`);
  if (Object.keys(a.args).length > 0) {
    lines.push(`   args:     ${JSON.stringify(a.args)}`);
  }
  lines.push(`   response: ${stringifyClipped(a.response)}`);
  lines.push(`   expected: ${stringifyClipped(a.expected)}`);
  return lines.join("\n");
}

export function formatArtifactBundle(
  artifacts: readonly McpFailureArtifact[],
): string {
  if (artifacts.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("Failure artifacts");
  lines.push("-----------------");
  for (const a of artifacts) {
    lines.push(formatArtifact(a));
    lines.push("");
  }
  return lines.join("\n");
}

const MAX_DUMP_LEN = 800;

function stringifyClipped(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= MAX_DUMP_LEN) return s;
  return `${s.slice(0, MAX_DUMP_LEN)}… [+${s.length - MAX_DUMP_LEN} chars]`;
}
