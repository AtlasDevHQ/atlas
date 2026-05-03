/**
 * OTel coverage for MCP tool dispatch (#2029).
 *
 * Mirrors the #1979 pattern (PR #2011): wraps the dispatch boundary with
 * `withSpan` from `@atlas/api/lib/tracing`, adds counter + latency-histogram
 * observations through the shared `@atlas/api` Meter in `@atlas/api/lib/metrics`,
 * and emits a one-time activation event the first time a workspace shows up.
 *
 * Reusing the API package's tracer + meter (rather than introducing a parallel
 * `@atlas/mcp` Meter) means a single `OTEL_EXPORTER_OTLP_ENDPOINT` configuration
 * picks up MCP signals — operators don't need a second exporter to see MCP
 * adoption alongside abuse / scheduler / plugin coverage.
 *
 * Process-local activation dedup: a `Set<string>` keyed on workspace id keeps
 * the activation Counter from re-firing within a single MCP process. We
 * deliberately do NOT deduplicate cross-process — each restart, each SSE
 * replica, and each fresh stdio process re-fires the counter for the same
 * workspace. Operators who want a true "unique workspaces" view should
 * configure their collector to group `atlas.mcp.activations` by
 * `workspace.id` × first-seen day. Without that downstream grouping, a
 * Claude Desktop restart will look like a new activation. We don't persist
 * activation rows because:
 *   1. Self-hosted MCP doesn't necessarily have an internal Postgres.
 *   2. The MCP stdio process is typically per-user-session anyway, so a
 *      "first observed" event per process is already a useful granularity.
 */

import { withSpan } from "@atlas/api/lib/tracing";
import {
  mcpToolCalls,
  mcpToolLatency,
  mcpActivations,
} from "@atlas/api/lib/metrics";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type McpTransport = "stdio" | "sse";

export type McpDeployMode = "self-hosted" | "saas";

export interface McpToolSpanContext {
  /** Tool name as registered with the MCP server. */
  readonly toolName: string;
  /** `actor.activeOrganizationId` — `system:mcp` in trusted-transport mode. */
  readonly workspaceId: string;
  /** Carrier transport. Set once at server boot, threaded through registration. */
  readonly transport: McpTransport;
  /** Resolved deploy mode — read once via `getConfig()` at registration time. */
  readonly deployMode: McpDeployMode;
  /**
   * Tool-specific span attributes (e.g. `metric.id` on `runMetric`).
   *
   * Attached to the span ONLY — never to the tool-call counter or latency
   * histogram. The counter / histogram label set is intentionally limited
   * to the four low-cardinality fields above so dashboards stay cheap.
   * Putting a high-cardinality value here (entity name, query hash) is
   * fine on the span but would blow up metric backend cardinality if it
   * leaked onto the counter.
   */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

const seenWorkspaces = new Set<string>();

/** Test-only: clear the activation cache so reset hooks see a clean state. */
export function _resetMcpTelemetryForTest(): void {
  seenWorkspaces.clear();
}

/**
 * Emit the activation event for `workspaceId` if it's the first one observed
 * in this process. Defensive try/catch: an OTel SDK bug must not bubble up
 * and turn into a `CallToolResult{ isError: true }` for the user — that
 * would violate the "instrumentation never masks the underlying tool"
 * contract in the wrong direction. On failure we log to stderr (matching
 * the MCP package's logging convention) and remove the workspace from the
 * cache so the next dispatch can retry.
 */
function emitActivationOnce(
  workspaceId: string,
  transport: McpTransport,
  deployMode: McpDeployMode,
): void {
  if (seenWorkspaces.has(workspaceId)) return;
  seenWorkspaces.add(workspaceId);
  try {
    mcpActivations.add(1, {
      "workspace.id": workspaceId,
      transport,
      "deploy.mode": deployMode,
    });
  } catch (err) {
    seenWorkspaces.delete(workspaceId);
    process.stderr.write(
      `[atlas-mcp] activation counter failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Wrap an MCP tool dispatch with span + counter + latency histogram + activation.
 *
 * Instrumentation never masks the underlying tool error: thrown errors from
 * `fn` are recorded on the span (via `withSpan`'s `recordException`) and on
 * the counter (with `outcome=error`), then re-thrown unchanged. Tool-level
 * error results (`CallToolResult.isError`) are tagged on the span via
 * `setResultAttributes` and recorded as `outcome=error` on the counter /
 * histogram so success and tool-level failure split cleanly.
 */
export async function traceMcpToolCall(
  ctx: McpToolSpanContext,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const spanAttributes: Record<string, string | number | boolean> = {
    "tool.name": ctx.toolName,
    "workspace.id": ctx.workspaceId,
    transport: ctx.transport,
    "deploy.mode": ctx.deployMode,
    ...(ctx.attributes ?? {}),
  };

  emitActivationOnce(ctx.workspaceId, ctx.transport, ctx.deployMode);

  const start = performance.now();
  let outcome: "success" | "error" = "success";
  try {
    const result = await withSpan(
      "atlas.mcp.tool.run",
      spanAttributes,
      fn,
      (r) => {
        const success = !r.isError;
        return success
          ? { "tool.success": true }
          : { "tool.success": false, "tool.error_code": "tool_error" };
      },
    );
    if (result.isError) outcome = "error";
    return result;
  } catch (err) {
    outcome = "error";
    // Re-throw the original — `withSpan` has already called `recordException`
    // with the original value. Wrapping non-Error throws here would lose
    // prototype identity / `cause` / tagged-error data that downstream
    // catches may discriminate on.
    throw err;
  } finally {
    const latencyMs = performance.now() - start;
    const obsAttrs = {
      "tool.name": ctx.toolName,
      transport: ctx.transport,
      "deploy.mode": ctx.deployMode,
      outcome,
    };
    mcpToolCalls.add(1, obsAttrs);
    mcpToolLatency.record(latencyMs, obsAttrs);
  }
}
