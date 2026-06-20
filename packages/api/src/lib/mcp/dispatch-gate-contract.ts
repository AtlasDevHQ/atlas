/**
 * MCP dispatch-gate CONTRACT — the neutral, dependency-light home for the
 * gate context + requirement shapes and the two pure gate primitives that the
 * ADR-0016 dispatch order is expressed in terms of (#3599).
 *
 * Why this module exists
 * ----------------------
 * The canonical gate composer (`runMcpDispatchGate`) lives in
 * `packages/mcp/src/dispatch-gate.ts`, but two callers need the *shapes* it
 * speaks without taking a runtime dependency on `packages/mcp`:
 *
 *   - `packages/mcp/src/dispatch-gate.ts` itself (and the native tools that
 *     build a context/requirements pair) — it re-exports these types so its
 *     existing `import … from "./dispatch-gate.js"` consumers are unchanged.
 *   - `packages/api/src/lib/plugins/mcp-tools.ts` — the plugin MCP dispatch
 *     wrapper. `packages/mcp` depends on `@atlas/api`, never the reverse, so
 *     the plugin path used to hand-maintain a *structural mirror* of the gate
 *     context/requirements (`PluginDispatchGate*`). That mirror drifted by
 *     hand; hoisting the real types here lets both packages import ONE
 *     definition while respecting the package-dependency direction
 *     (`@atlas/api` owns the contract; `packages/mcp` imports it).
 *
 * This file is deliberately free of any `@modelcontextprotocol/sdk` import —
 * it describes the *inputs* to the gate (actor, scopes, requirements), never
 * the `CallToolResult` it returns. That keeps it importable from both the
 * SDK-aware `packages/mcp` and the SDK-free `@atlas/api` plugin layer.
 */

import type { AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import type { McpActionCategory } from "@useatlas/types/mcp";

/**
 * Per-dispatch context the gate evaluates: the bound MCP actor (whose
 * live-resolved role, #3505, is gate 3's authority), the OAuth client/scopes
 * (gate 2), the admitted workspace (gate 0/1/4), and the requester identity
 * for approval attribution (gate 4).
 */
export interface McpDispatchGateContext {
  /** Bound MCP actor — its live-resolved role (#3505) is gate 3's authority. */
  readonly actor: AtlasUser;
  /** Hosted-MCP OAuth client_id; absent for stdio (which is scope-exempt). */
  readonly clientId?: string;
  /** OAuth token scopes (#3504), threaded onto RequestContext at dispatch. */
  readonly scopes?: readonly string[];
  /** Resolved workspace id (the admitted org). */
  readonly orgId: string | undefined;
  /** Requester id for approval attribution (typically the bound actor's id). */
  readonly requesterId?: string;
  /** Requester email stamped on the approval request, when known. */
  readonly requesterEmail?: string | null;
  /** Per-call request id for log correlation. */
  readonly requestId?: string;
}

/**
 * The declarative gate requirement set for a tool. Which gates a dispatch
 * passes is determined ENTIRELY by this object — not by which file registered
 * the tool (#3601). A reader answers "what is the full gate order for tool X"
 * by reading X's requirements here.
 */
export interface McpDispatchGateRequirements {
  /** Tool name for logs / envelopes. */
  readonly toolName: string;
  /**
   * Gate 0: workspace billing solvency (#3437/#3570). When `true`, a
   * suspended / trial-expired / plan-exhausted workspace short-circuits
   * BEFORE the action-policy / scope / RBAC / approval gates — billing is
   * conceptually gate-0 (can the workspace transact at all?). Omit (or
   * `false`) for metadata-only tools that touch no datasource (`explore`,
   * `listEntities`, `describeEntity`, `searchGlossary`) — see `billing-gate.ts`.
   */
  readonly checksBilling?: boolean;
  /**
   * Gate 1: the MCP action *category* this tool belongs to (e.g.
   * `"datasource"`). When set AND the workspace blocks that category, the
   * dispatch short-circuits before any other gate. Omit for tools not subject
   * to the per-workspace kill-switch (there is no category to block, so gate 1
   * is a no-op for them).
   */
  readonly actionCategory?: McpActionCategory;
  /** Gate 2: the tool mutates data → require the `mcp:write` scope (hosted). */
  readonly requiresWrite: boolean;
  /** Gate 3: minimum RBAC role on the bound actor (e.g. `"admin"`). */
  readonly minRole: AtlasRole;
  /**
   * Gate 4: a destructive action that must route through the approval gate.
   * Omit for non-destructive (e.g. read-back / list) admin tools. `resource`
   * is the approval-matchable target (e.g. `"datasource:prod-db"`) matched
   * against `origin=mcp` approval rules; `description` is stored on the
   * queued request so a reviewer sees what was attempted.
   */
  readonly destructive?: {
    readonly resource: string;
    readonly description: string;
  };
}

/**
 * Structural mirror of MCP's standard `ToolAnnotations` (spec 2025-11-25).
 * Only the read/write hints are load-bearing for the host today — the
 * `mcp:write` dispatch gate (gate 2) keys on them via {@link mcpToolMutates}.
 * `idempotentHint` / `openWorldHint` / `title` are accepted and carried for
 * forward-compat (annotation surfacing, #3497) but unused by enforcement.
 *
 * Why annotations, not a bespoke `mutates` flag (#3520): MCP already defines
 * `readOnlyHint` / `destructiveHint`, so a plugin author declares mutation in
 * the protocol's own vocabulary and a future MCP client reads the same hint.
 */
export interface McpToolAnnotationsShape {
  readonly title?: string;
  /** `true` ⇒ the tool does not mutate its environment (read-only). */
  readonly readOnlyHint?: boolean;
  /** `true` ⇒ the tool may perform destructive (mutating) updates. */
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * The SINGLE `mutates` notion (#3599). Both the native datasource tools and
 * the plugin tools resolve the gate's `requiresWrite` through this one
 * predicate, derived from the MCP annotation vocabulary — so "does this tool
 * mutate?" has exactly one answer regardless of who authored the tool.
 *
 * Opt-in by design (#3520): a tool with no annotations is treated as
 * read-only, so existing read-only tools are unaffected for `mcp:read`
 * clients. A tool opts into the gate by declaring `readOnlyHint: false` or
 * `destructiveHint: true`. `readOnlyHint: true` always wins (a tool can't be
 * both read-only and destructive).
 */
export function mcpToolMutates(annotations?: McpToolAnnotationsShape): boolean {
  if (!annotations) return false;
  if (annotations.readOnlyHint === true) return false;
  return annotations.destructiveHint === true || annotations.readOnlyHint === false;
}

/**
 * Gate 2 (`mcp:write` scope) — the pure decision, dependency-free so both the
 * `packages/mcp` composer and the `@atlas/api` plugin fallback share ONE
 * source of truth instead of re-implementing the scope check (#3504/#3599).
 *
 * Returns `true` when a HOSTED dispatch (`clientId` set) is MISSING the
 * `mcp:write` scope it needs — i.e. the dispatch must be denied. stdio
 * (`clientId` undefined) carries no third-party client, so no scope term
 * applies and this always returns `false` (exempt). The caller renders the
 * denial envelope in its own vocabulary (`writeScopeOrNull` /
 * `envelopeResult`).
 */
export function writeScopeDenied(args: {
  clientId: string | undefined;
  scopes: readonly string[] | undefined;
}): boolean {
  if (!args.clientId) return false; // stdio exempt — no third-party client
  return !args.scopes?.includes("mcp:write");
}
