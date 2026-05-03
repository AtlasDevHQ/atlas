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
 * the activation Counter from re-firing within a single MCP process. Across
 * SaaS replicas / restarts the dedup is downstream — collectors group by
 * `workspace.id` × first-seen day. We don't persist activation rows because:
 *   1. Self-hosted MCP doesn't necessarily have an internal Postgres.
 *   2. The MCP stdio process is typically per-user-session anyway, so a
 *      "first observed" event per process is already the natural granularity.
 */

import { withSpan } from "@atlas/api/lib/tracing";
import {
  mcpToolCalls,
  mcpToolLatency,
  mcpActivations,
} from "@atlas/api/lib/metrics";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type McpTransport = "stdio" | "sse";

export interface McpToolSpanContext {
  /** Tool name as registered with the MCP server. */
  readonly toolName: string;
  /** `actor.activeOrganizationId` — `system:mcp` in trusted-transport mode. */
  readonly workspaceId: string;
  /** Carrier transport. Set once at server boot, threaded through registration. */
  readonly transport: McpTransport;
  /** `self-hosted` or `saas` — read once via `getConfig()` at registration time. */
  readonly deployMode: string;
  /** Tool-specific span attributes (e.g. `metric.id` on `runMetric`). */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

const seenWorkspaces = new Set<string>();

/** Test-only: clear the activation cache so reset hooks see a clean state. */
export function _resetMcpTelemetryForTest(): void {
  seenWorkspaces.clear();
}

/**
 * Wrap an MCP tool dispatch with span + counter + latency histogram + activation.
 *
 * Instrumentation never masks the underlying tool error: thrown errors from
 * `fn` are recorded on the span and counter (with `outcome=error`) and then
 * re-thrown unchanged. Tool-level error results (`CallToolResult.isError`) are
 * tagged on the span via `setResultAttributes` and recorded as `outcome=error`
 * on the counter / histogram so success and tool-level failure split cleanly.
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

  if (!seenWorkspaces.has(ctx.workspaceId)) {
    seenWorkspaces.add(ctx.workspaceId);
    mcpActivations.add(1, {
      "workspace.id": ctx.workspaceId,
      transport: ctx.transport,
      "deploy.mode": ctx.deployMode,
    });
  }

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
    // Re-throw the original error so the caller's catch can shape the
    // CallToolResult exactly as before; the surrounding span has already
    // recorded `recordException` via `withSpan`.
    throw err instanceof Error ? err : new Error(String(err));
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
