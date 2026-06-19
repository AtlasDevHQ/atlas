/**
 * Shared MCP tool dispatch wrapper (#3602).
 *
 * Every Atlas MCP tool — `explore`/`executeSQL` (tools.ts), the typed semantic
 * tools (semantic-tools.ts), and the datasource lifecycle tools
 * (datasource-tools.ts) — runs its handler through ONE wrapper so the
 * cross-cutting dispatch contract lives in a single place:
 *
 *   traceMcpToolCall (OTel span/counter/latency, #2029)
 *     → withRequestContext (bind the `mcp` actor so audit_log + RLS +
 *       origin-scoped approval rules see the caller, #1858/#2067/#3507)
 *       → rate-limit gate (per-OAuth-client, hosted only, #2071)
 *       → runMcpDispatchGate (ADR-0016 gate order 0–4, #3508/#3601)
 *       → the tool body
 *       → catch → typed `internal_error` envelope (with request_id, #2030)
 *
 * Before #3602 this skeleton was hand-inlined ~10 times across the three tool
 * files (and the billing-gate placement had already drifted between them — the
 * exact failure mode this consolidation removes). A change to the
 * actor-binding / rate-limit / gate-order / error-envelope contract is now made
 * once, here, and `reqs` is the single declarative statement of which gates a
 * tool gets.
 *
 * The dispatch gate is lazy-imported on first invocation: it transitively
 * pulls the approval/enterprise services and the billing gate, so importing it
 * at module load would couple MCP server *registration* (which only needs tool
 * metadata) to that whole graph. ESM caches the module; this just defers it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import { enforceClientRateLimit } from "@atlas/api/lib/rate-limit/middleware";
import type { McpDispatchGateRequirements } from "@atlas/api/lib/mcp/dispatch-gate-contract";
import {
  traceMcpToolCall,
  type McpTransport,
  type McpDeployMode,
} from "./telemetry.js";
import { envelope, toEnvelopeResult } from "./error-envelope.js";
import { OperationCancelledError } from "./progress.js";
import { createMcpLogger } from "./logger.js";

const log = createMcpLogger("mcp:dispatch");

// Lazy gate loader — see the module header for why registration stays off the
// approval/enterprise/billing graph.
type DispatchGateModule = typeof import("./dispatch-gate.js");
let dispatchGateModule: Promise<DispatchGateModule> | null = null;
const dispatchGate = (): Promise<DispatchGateModule> =>
  (dispatchGateModule ??= import("./dispatch-gate.js"));

export interface McpDispatchOptions {
  /** Actor bound on every dispatch (resolved once at server boot). */
  readonly actor: AtlasUser;
  /** OTel transport tag (#2029). */
  readonly transport: McpTransport;
  /**
   * Resolved workspace id for OTel attribution + rate-limit scoping
   * (`actor.activeOrganizationId` or, when no org is bound, `actor.id`). NOTE:
   * the dispatch gate keys billing/policy/approval on `actor.activeOrganizationId`
   * directly (NOT this fallback) so the gate's no-org short-circuits hold.
   */
  readonly workspaceId: string;
  /** Resolved `deployMode` for OTel attribution. */
  readonly deployMode: McpDeployMode;
  /** Hosted-MCP OAuth client_id (#2067); undefined for stdio (rate-limit + scope exempt). */
  readonly clientId?: string;
  /** #3504 — OAuth token scopes, threaded onto each dispatch's RequestContext. */
  readonly scopes?: readonly string[];
}

/** The per-dispatch requirement set, minus `toolName` (supplied per call). */
export type McpToolRequirements = Omit<McpDispatchGateRequirements, "toolName">;

export interface McpDispatcher {
  /**
   * Run a tool body through the full dispatch contract. `reqs` declares the
   * tool's gates (billing/category/write/role/destructive). The body runs only
   * after every gate clears; a gate denial / approval-required short-circuit is
   * returned verbatim. Any throw becomes an `internal_error` envelope carrying
   * the dispatch's `request_id` (a client-cancellation `OperationCancelledError`
   * is re-thrown so the SDK suppresses the response, not coerced into an error).
   */
  dispatch(
    toolName: string,
    reqs: McpToolRequirements,
    body: (requestId: string) => Promise<CallToolResult>,
    /** Optional extra OTel span attributes for this tool (e.g. `{ "metric.id": id }`). */
    spanAttributes?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<CallToolResult>;
}

function dispatchId(toolName: string): string {
  return `mcp-${toolName}-${crypto.randomUUID()}`;
}

/**
 * Normalize a caught value to a message string (CLAUDE.md: `err instanceof
 * Error ? err.message : String(err)`), falling back only for the truly opaque
 * case (`String(err)` → `""` / `"[object Object]"`). Exported so the tool files
 * that compose with this dispatcher share ONE normalizer rather than each
 * keeping a private copy (#3602/#3607-review).
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  const s = String(err);
  return s && s !== "[object Object]" ? s : fallback;
}

/**
 * Append a trial days-remaining advisory to a successful tool result (ADR-0018
 * / #3651). Returns the result unchanged when `days` is null (off-SaaS /
 * no-org / non-trial) or the result is an error envelope — so the annotation is
 * purely additive and never converts a success into an error. Pure + exported
 * for unit testing without the full dispatch machinery.
 */
export function withTrialFooter(
  result: CallToolResult,
  days: number | null,
): CallToolResult {
  if (days === null || result.isError) return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text" as const,
        text:
          `Atlas trial: ${days} day${days === 1 ? "" : "s"} remaining. ` +
          `Subscribe on the web before it ends to keep querying.`,
      },
    ],
  };
}

/**
 * Build a dispatcher bound to one MCP server's actor/transport/workspace. Every
 * tool file constructs one (`const { dispatch } = createMcpDispatch(opts)`) and
 * routes each `server.registerTool` handler through it.
 */
export function createMcpDispatch(opts: McpDispatchOptions): McpDispatcher {
  const { actor, transport, workspaceId, deployMode, clientId, scopes } = opts;

  // #2067 — the same `actor` shape every tool stamps so
  // `audit_log.{actor_kind, client_id, tool_name}` is populated regardless of
  // which tool the caller picks. `clientId` stays undefined for stdio.
  const mcpActor = (toolName: string) => ({
    kind: "mcp" as const,
    ...(clientId ? { clientId } : {}),
    toolName,
  });

  // Per-OAuth-client rate-limit gate (#2071) — hosted threads `clientId`; stdio
  // leaves it undefined and is exempt (the limiter scopes hosted-tenant abuse,
  // not the operator's own bench testing).
  async function rateLimitOrNull(toolName: string): Promise<CallToolResult | null> {
    if (!clientId) return null;
    const outcome = await enforceClientRateLimit({
      orgId: workspaceId,
      clientId,
      userId: actor.id,
      toolName,
    });
    if (outcome.kind === "ok") return null;
    return toEnvelopeResult(outcome.envelope);
  }

  async function dispatch(
    toolName: string,
    reqs: McpToolRequirements,
    body: (requestId: string) => Promise<CallToolResult>,
    spanAttributes?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<CallToolResult> {
    return traceMcpToolCall(
      {
        toolName,
        workspaceId,
        transport,
        deployMode,
        ...(spanAttributes ? { attributes: spanAttributes } : {}),
      },
      () => {
        const requestId = dispatchId(toolName);
        return withRequestContext(
          {
            requestId,
            user: actor,
            actor: mcpActor(toolName),
            agentOrigin: "mcp",
            ...(scopes ? { scopes } : {}),
          },
          async () => {
            try {
              // Rate-limit FIRST (cheap, hosted-only). Inside the try so any
              // limiter throw lands in the same catch as a tool throw and
              // surfaces an `internal_error` envelope (#2030).
              const limited = await rateLimitOrNull(toolName);
              if (limited) return limited;

              // ADR-0016 dispatch gate order (0 billing → 1 action-policy →
              // 2 scope → 3 RBAC → 4 approval), composed once in
              // `runMcpDispatchGate`. The gate keys billing/policy/approval on
              // `actor.activeOrganizationId` (not the OTel `workspaceId`
              // fallback) so the no-org short-circuits hold.
              const gateBlock = await (await dispatchGate()).runMcpDispatchGate(
                {
                  actor,
                  ...(clientId ? { clientId } : {}),
                  ...(scopes ? { scopes } : {}),
                  orgId: actor.activeOrganizationId,
                  requesterId: actor.id,
                  requesterEmail: actor.label,
                  requestId,
                },
                { toolName, ...reqs },
              );
              if (gateBlock) return gateBlock;

              const result = await body(requestId);
              // ADR-0018 / #3651 — surface trial days-remaining on successful
              // billing-gated tool responses (executeSQL / runMetric / setup),
              // so post-claim Q&A and setup over MCP keep the trial clock
              // visible. `getTrialDaysRemaining` never throws and returns null
              // off-SaaS / no-org / non-trial, so this is a no-op for stdio and
              // self-hosted. `withTrialFooter` skips error envelopes.
              //
              // Lazy-imported for the same reason the dispatch gate is (see the
              // module header): keep MCP tool *registration* off the
              // billing/enforcement graph. enforcement.ts is already pulled by
              // the gate on any `checksBilling` dispatch, so this adds no new
              // static coupling.
              if (!reqs.checksBilling) return result;
              const { getTrialDaysRemaining } = await import(
                "@atlas/api/lib/billing/enforcement"
              );
              const days = await getTrialDaysRemaining(actor.activeOrganizationId);
              return withTrialFooter(result, days);
            } catch (err) {
              // Client-initiated cancellation (#3500) is not a tool failure —
              // the SDK already suppressed the response, so propagate it.
              if (err instanceof OperationCancelledError) throw err;
              const message = errorMessage(err, `${toolName} tool failed`);
              log.error(
                {
                  err: err instanceof Error ? err : new Error(String(err)),
                  toolName,
                  requestId,
                },
                `${toolName} tool threw`,
              );
              return toEnvelopeResult(
                envelope("internal_error", message, { request_id: requestId }),
              );
            }
          },
        );
      },
    );
  }

  return { dispatch };
}
