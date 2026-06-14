/**
 * MCP dispatch gate-order pipeline (#3508 / ADR-0016).
 *
 * Every MUTATING MCP tool routes its dispatch through this composer before
 * doing any work. The gate order is fixed by ADR-0016; this module wires
 * gates 1–4 (gate 5, inline confirm via destructiveHint + elicitation, lands
 * in #3497/#3499):
 *
 *   1. MCP action policy  — the per-workspace customer-admin kill-switch
 *      (#3509). A tool that declares an `actionCategory` is short-circuited
 *      when that category is BLOCKED for the workspace — BEFORE scope / RBAC /
 *      approval, since the customer's "no datasource creation via MCP at all"
 *      decision overrides everything downstream. Consulted via the lib-layer
 *      {@link loadMcpActionPolicy} (NEVER loopback HTTP). Fails closed: a DB
 *      error reading the policy blocks rather than proceeds.
 *   2. `mcp:write` scope  — hosted only; stdio is exempt (no third-party
 *      client). Reuses {@link writeScopeOrNull} (#3504).
 *   3. RBAC role          — authority is the bound MCP actor's role,
 *      live-resolved at bearer-verify time (#3505), compared on the
 *      member < admin < owner < platform_admin hierarchy via
 *      {@link meetsRoleRequirement}. Called directly on the lib layer —
 *      NEVER a loopback HTTP proxy (ADR-0016).
 *   4. Approval flow      — destructive actions route through Atlas's
 *      existing approval gate keyed on `origin=mcp`. If a matching rule
 *      fires (and the requester hasn't already been approved), an approval
 *      request is queued and the caller is told to wait.
 *
 * Every gate FAILS CLOSED: a missing scope, an insufficient/absent role, or
 * an unavailable approval gate denies rather than proceeds. Read-only tools
 * never call this; the origin ceiling (MCP can raise but never lower
 * governance) is enforced structurally by which tools exist, not here.
 *
 * Returns `null` when all gates clear (the caller proceeds), or a
 * `CallToolResult` to short-circuit: a `forbidden` envelope for a
 * scope/RBAC denial, or a non-error `approval_required` JSON body for gate 4
 * (mirroring the shape executeSQL already surfaces, so agents/SDK parse one
 * contract).
 */

import { Effect } from "effect";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpActionCategory } from "@useatlas/types/mcp";
import type { AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import { meetsRoleRequirement, getUserRole } from "@atlas/api/lib/auth/permissions";
import {
  loadMcpActionPolicy,
  type McpActionPolicy,
} from "@atlas/api/lib/mcp/action-policy";
import {
  ApprovalGate,
  type ApprovalGateShape,
} from "@atlas/api/lib/effect/services";
import { EnterpriseUnavailableError } from "@atlas/api/lib/effect/errors";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
import { isEnterpriseEnabled } from "@atlas/api/lib/effect/enterprise-config";
import { createLogger } from "@atlas/api/lib/logger";
import { writeScopeOrNull } from "./tools.js";
import { envelope, toEnvelopeResult } from "./error-envelope.js";
import { getLiveActor } from "./live-actor-store.js";

const log = createLogger("mcp:dispatch-gate");

/**
 * Resolve the `ApprovalGate` Tag fail-closed — mirrors `loadApprovalGate`
 * in `lib/tools/sql.ts`. On SaaS (`ATLAS_ENTERPRISE_ENABLED=true`) a gate
 * that didn't bind is a governance break, so we throw rather than treat it
 * as "no rules". Self-hosted with `available: false` is the expected no-op.
 */
function loadApprovalGate(): Promise<ApprovalGateShape> {
  return runEnterprise(
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      if (isEnterpriseEnabled() && !gate.available) {
        return yield* Effect.fail(
          new EnterpriseUnavailableError({
            message:
              "Approval gate unavailable — MCP action blocked to prevent governance bypass. Contact your administrator.",
            tag: "ApprovalGate",
          }),
        );
      }
      return gate;
    }),
  );
}

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

export interface McpDispatchGateRequirements {
  /** Tool name for logs / envelopes. */
  readonly toolName: string;
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

export interface McpDispatchGateDeps {
  /**
   * Override the approval-gate loader (tests inject a mock
   * {@link ApprovalGateShape}). Defaults to the fail-closed EE loader.
   */
  readonly loadApprovalGate?: () => Promise<ApprovalGateShape>;
  /**
   * Override the gate-1 action-policy loader (tests inject a stub
   * {@link McpActionPolicy}). Defaults to the lib-layer
   * {@link loadMcpActionPolicy} (DB-backed, never loopback HTTP).
   */
  readonly loadActionPolicy?: (orgId: string) => Promise<McpActionPolicy>;
}

/**
 * Run the MCP dispatch gate order (scope → RBAC → approval). Returns `null`
 * when the caller may proceed, or a `CallToolResult` to short-circuit.
 */
export async function runMcpDispatchGate(
  ctx: McpDispatchGateContext,
  reqs: McpDispatchGateRequirements,
  deps: McpDispatchGateDeps = {},
): Promise<CallToolResult | null> {
  // ── Gate 1: per-workspace MCP action policy kill-switch (#3509) ──
  // Short-circuits BEFORE scope/RBAC/approval: the customer admin's "disable
  // this whole category via MCP" decision overrides everything downstream.
  // Needs a workspace to look up — with no orgId there is no per-workspace
  // policy, so gate 1 is a no-op and the later gates (RBAC, approval identity
  // guard) enforce the missing-identity case.
  if (reqs.actionCategory && ctx.orgId) {
    const policyBlock = await runActionPolicyGate(ctx, reqs.actionCategory, reqs.toolName, deps);
    if (policyBlock) return policyBlock;
  }

  // ── Gate 2: mcp:write scope (hosted only; stdio exempt via clientId) ──
  if (reqs.requiresWrite) {
    const scopeBlock = writeScopeOrNull({ clientId: ctx.clientId, scopes: ctx.scopes });
    if (scopeBlock) return scopeBlock;
  }

  // ── Gate 3: RBAC role on the bound actor (live-resolved, #3505/#3569) ──
  //
  // For EXISTING hosted sessions the `ctx.actor` was captured at session-
  // creation time. A mid-session demotion must be revocation-immediate (ADR-
  // 0016: "RBAC is the only source of authority"). `withLiveActor` in
  // `hosted.ts` sets the per-request freshly-resolved actor on a separate ALS
  // that is NOT overwritten by nested `withRequestContext` calls in tool
  // dispatch bodies. We prefer the live actor when present; `ctx.actor` is
  // the correct authority for stdio (no live-actor store) and unit tests.
  const rbacActor: AtlasUser = getLiveActor() ?? ctx.actor;
  if (!meetsRoleRequirement(rbacActor, reqs.minRole)) {
    log.warn(
      {
        toolName: reqs.toolName,
        actorRole: getUserRole(rbacActor),
        minRole: reqs.minRole,
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      },
      "MCP admin tool denied at RBAC — actor role below required minimum",
    );
    return toEnvelopeResult(
      envelope(
        "forbidden",
        `This tool requires the '${reqs.minRole}' role (or higher); your role does not meet that.`,
        {
          hint: "Ask a workspace owner/admin to run this action, or have them grant you the role.",
        },
      ),
    );
  }

  // ── Gate 4: approval flow for destructive actions (origin=mcp) ──
  if (reqs.destructive) {
    return runApprovalGate(ctx, reqs.destructive, deps);
  }

  return null;
}

/**
 * Gate 1 — the per-workspace MCP action policy kill-switch. Returns a
 * `forbidden` envelope when the category is blocked, `null` to proceed, and an
 * `internal_error` envelope (fail closed) when the policy can't be read. The
 * lib-layer loader (`loadMcpActionPolicy`) returns all-allowed when no internal
 * DB is configured, so self-hosted-without-a-DB proceeds; only a genuine read
 * error blocks.
 */
async function runActionPolicyGate(
  ctx: McpDispatchGateContext,
  actionCategory: McpActionCategory,
  toolName: string,
  deps: McpDispatchGateDeps,
): Promise<CallToolResult | null> {
  try {
    const load = deps.loadActionPolicy ?? loadMcpActionPolicy;
    const policy = await load(ctx.orgId!);
    if (!policy.isBlocked(actionCategory)) return null;

    log.warn(
      {
        toolName,
        actionCategory,
        orgId: ctx.orgId,
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      },
      "MCP tool denied at gate 1 — action category blocked by workspace policy",
    );
    return toEnvelopeResult(
      envelope(
        "forbidden",
        `MCP '${actionCategory}' actions are disabled for this workspace by an administrator.`,
        {
          hint: "A workspace admin can re-enable this category under Admin → MCP action policy.",
        },
      ),
    );
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        toolName,
        actionCategory,
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      },
      "MCP action policy unavailable / errored — blocking action (fail-closed)",
    );
    return toEnvelopeResult(
      envelope(
        "internal_error",
        "MCP action policy unavailable — action blocked. Contact your administrator.",
        ctx.requestId ? { request_id: ctx.requestId } : undefined,
      ),
    );
  }
}

async function runApprovalGate(
  ctx: McpDispatchGateContext,
  destructive: NonNullable<McpDispatchGateRequirements["destructive"]>,
  deps: McpDispatchGateDeps,
): Promise<CallToolResult | null> {
  // Identity guard FIRST (before consulting the gate): a destructive action
  // with no bound requester/workspace must deny, not fall through. Gate 3
  // already requires a bound admin, but checking here keeps the guard
  // load-bearing for any future caller that derives identity differently —
  // and must precede `checkApprovalRequired`, which returns `required:false`
  // for an undefined org (so an absent org would otherwise skip approval).
  if (!ctx.orgId || !ctx.requesterId) {
    return toEnvelopeResult(
      envelope(
        "forbidden",
        "This action requires approval but the requester identity could not be determined.",
      ),
    );
  }
  const orgId = ctx.orgId;
  const requesterId = ctx.requesterId;

  // One fail-closed boundary around EVERY approval-gate interaction. The EE
  // impl runs its reads via `Effect.promise` (DB rejection → defect →
  // `runPromise` throws), so checkApprovalRequired / hasApprovedRequest can
  // throw despite their `never` error channel — a DB blip during the *check*
  // must block the destructive action, not escape as an unhandled rejection.
  // Mirrors executeSQL's single tryPromise around the whole approval block.
  try {
    const load = deps.loadApprovalGate ?? loadApprovalGate;
    const gate = await load();

    const tablesAccessed = [destructive.resource];
    const match = await Effect.runPromise(
      gate.checkApprovalRequired(orgId, tablesAccessed, [], {
        requesterId,
        origin: "mcp",
      }),
    );
    if (!match.required) return null;

    // Don't re-queue a request the requester has already had approved for the
    // same action (parity with executeSQL — avoids duplicate approvals on retry).
    const alreadyApproved = await Effect.runPromise(
      gate.hasApprovedRequest(orgId, requesterId, destructive.description),
    );
    if (alreadyApproved) return null;

    const firstRule = match.matchedRules[0];
    const req = await Effect.runPromise(
      gate.createApprovalRequest({
        orgId,
        ruleId: firstRule.id,
        ruleName: firstRule.name,
        requesterId,
        requesterEmail: ctx.requesterEmail ?? null,
        querySql: destructive.description,
        explanation: destructive.description,
        connectionId: null,
        tablesAccessed,
        columnsAccessed: [],
        origin: "mcp",
      }),
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              approval_required: true,
              approval_request_id: req.id,
              matched_rules: match.matchedRules.map((r) => r.name),
              message:
                `This action requires approval before execution. Rule: "${firstRule.name}". ` +
                `An approval request has been submitted (ID: ${req.id}).`,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      },
      "Approval gate unavailable / errored — blocking destructive MCP action (fail-closed)",
    );
    return toEnvelopeResult(
      envelope(
        "internal_error",
        "Approval system unavailable — action blocked. Contact your administrator.",
        ctx.requestId ? { request_id: ctx.requestId } : undefined,
      ),
    );
  }
}
