/**
 * Wire format for the semantic-layer exploration REST endpoint
 * (`POST /api/v1/explore`, #4049 / ADR-0027) — the REST sibling of the agent
 * loop's / MCP `explore` tool.
 *
 * SSOT for the route's local hono-`z` `ExploreResponseSchema`
 * (`satisfies z.ZodType<ExploreRestResponse>`). A command-level failure
 * (a `grep` that matched nothing, a missing file) rides inside `output` as the
 * facade's `Error (exit N):` string — a normal 200 result, not an HTTP error.
 */
export interface ExploreRestResponse {
  /** The command's combined output (including non-zero-exit results). */
  readonly output: string;
}
