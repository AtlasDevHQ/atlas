/**
 * Agent-Auth identity → `AtlasUser` — the SIXTH producer of the single
 * identity abstraction the MCP dispatch gate (`runMcpDispatchGate`) and RBAC
 * (`meetsRoleRequirement`) consume (#4409, reversibility constraint from
 * #4408 AC4).
 *
 * ── Why this is the reversible seam ─────────────────────────────────────────
 *
 * `AtlasUser` is already produced by five mechanisms (managed session, API key,
 * simple key, hosted OAuth bearer, cli device bearer). Agent Auth plugs in here
 * as the sixth: this module — and the `agentAuth()` plugin's `onExecute` that
 * calls it — are the ONLY places that know about the agent-session / agent-JWT
 * *shapes*. Everything downstream sees a plain `AtlasUser`. So a future switch
 * to an OAuth-native (ID-JAG / `auth.md`) agent-identity flow replaces this
 * producer and touches nothing in the enforcement core (`dispatch-gate.ts`,
 * `dispatch-gate-contract.ts`, `permissions.ts`) — the invariant the
 * `agent-auth-seam-quarantine` test pins. (The discovery route + the gate
 * naturally know the surface exists; the quarantine is about the *enforcement
 * core*, not every file.)
 *
 * AUTHORITATIVE shape-quarantine enumeration (other module headers point here;
 * scope each claim by shape, not by "agent-auth" at large):
 *   - Agent SESSION / agent-JWT shapes: `agent-auth-plugin.ts` (adapts
 *     `agentSession` at the boundary) and `agent-auth-openapi.ts` (adapter
 *     options). This module deliberately does NOT know `AgentSession` — it
 *     consumes only the plugin-agnostic `AgentAuthIdentity` below.
 *   - Agent-auth EVENT shapes: `agent-auth-audit.ts` (the `onEvent` bridge) and
 *     the plugin factory that wires it.
 *   - On/off decision + path shape ONLY (no token/session/event knowledge):
 *     `agent-auth-gate.ts` and the two HTTP surfaces that consult it.
 *
 * ── Trust boundary ──────────────────────────────────────────────────────────
 *
 * An agent credential is a delegated, portable bearer — strictly less trusted
 * than the local operator. It resolves ORG (member) role ONLY, withholding
 * `platform_admin`, exactly like the `hosted` and `cli` transports. That rule
 * is DECLARED canonically by the `"agent"` arm of `resolveMcpActorRole`
 * (`packages/mcp/src/bind-actor.ts`) and pinned by `bind-actor.test`. This
 * module reaches the SAME `resolveEffectiveRole(undefined, …)` boundary directly
 * rather than calling `resolveMcpActorRole` at runtime — the identical pattern
 * the stdio production path uses (it reaches `resolveEffectiveRole` through
 * `loadActorUser`, not through the switch) and required here to avoid a static
 * `@atlas/api → @atlas/mcp` import (the api bundle loads `@atlas/mcp` only via
 * lazy dynamic `import()`; see `api/index.ts`). The trust arm remains the
 * canonical declaration; this is a same-boundary reach.
 *
 * ── Workspace binding is membership-enforced, never claim-trusted ────────────
 *
 * The agent proposes a workspace (carried in `agent.metadata.workspaceId`), but
 * it is honored ONLY if the agent's owning Atlas user is a live member of that
 * workspace — the same authoritative-membership posture the hosted MCP edge
 * uses (`bindFactoryContext`). A leaked/misconfigured agent claiming a workspace
 * its owner can't reach is DENIED. This is what enforces cross-workspace
 * isolation: an agent registered under a user who belongs only to workspace A
 * can never resolve an identity scoped to workspace B.
 *
 * Fail-closed throughout: a missing workspace, a non-member owner, or a
 * membership-lookup error all resolve to `denied`, never a broader identity.
 */

import { createAtlasUser, type AtlasUser } from "@atlas/api/lib/auth/types";
import { resolveEffectiveRole } from "@atlas/api/lib/auth/effective-role";
import { listUserWorkspaceIds } from "@atlas/api/lib/auth/oauth-workspace-grants";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:agent-auth-verifier");

/**
 * The minimal, plugin-agnostic identity shape this producer maps to an
 * `AtlasUser`. Deliberately NOT `@better-auth/agent-auth`'s `AgentSession` — the
 * seam depends only on these fields, so swapping the underlying agent-identity
 * library never reshapes this contract. The `agentAuth()` plugin's `onExecute`
 * adapts its `agentSession` into this shape at the boundary.
 */
export interface AgentAuthIdentity {
  /** The real Atlas user the agent acts for (`agentSession.userId ?? user.id`). */
  readonly userId: string;
  /** Workspace the agent proposes to act in (from `agent.metadata.workspaceId`). */
  readonly requestedWorkspaceId: string | undefined;
  /** Agent id — carried into claims/label for audit correlation. */
  readonly agentId: string;
  /** Display label for the bound actor (defaults to the user id). */
  readonly label?: string;
}

/**
 * The compile-checked key set of the claims bag this producer stamps onto the
 * resolved `AtlasUser`. `AtlasUser.claims` stays a wide
 * `Record<string, unknown>` (it is shared by every producer), but building the
 * bag through `satisfies AgentAuthClaims` means a consumer typing these keys by
 * hand (RLS, audit) has one declaration to import and a producer-side typo is a
 * compile error, not silent claim loss.
 */
export interface AgentAuthClaims {
  readonly agent_auth: true;
  readonly agent_id: string;
  readonly active_organization_id: string;
}

/**
 * Discriminated outcome. `denied` carries a machine reason so the `onExecute`
 * caller can map it to the right agent-auth error envelope without re-deriving
 * the cause.
 */
export type AgentAuthActorResult =
  // `workspaceId` is carried explicitly (not just implied by
  // `user.activeOrganizationId`, which is typed `string | undefined`) so the
  // caller reads a guaranteed `string` — encoding "an `ok` always has a bound
  // workspace" in the type instead of a downstream runtime guard.
  | { readonly kind: "ok"; readonly user: AtlasUser; readonly workspaceId: string }
  | {
      readonly kind: "denied";
      readonly reason: "missing_workspace" | "not_a_member" | "membership_lookup_failed";
    };

/**
 * Resolve an `AtlasUser` for an agent-auth identity, or a typed denial.
 *
 * The plugin has already verified the agent JWT (signature, `aud`, expiry, jti
 * replay) and the capability grant before `onExecute` runs — this producer adds
 * the Atlas-side identity binding: which workspace, which role, membership-gated.
 */
export async function resolveAgentAuthActor(
  identity: AgentAuthIdentity,
): Promise<AgentAuthActorResult> {
  const workspaceId = identity.requestedWorkspaceId?.trim();
  if (!workspaceId) {
    // No workspace binding → nothing to scope to. The org-scoped lib seam would
    // hard-fail anyway; denying here yields a precise, actionable reason.
    return { kind: "denied", reason: "missing_workspace" };
  }

  // Authoritative membership check — the agent-proposed workspace is honored
  // ONLY if the owning user is a live member. Never trust the claim itself.
  let memberships: string[];
  try {
    memberships = await listUserWorkspaceIds(identity.userId);
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        userId: identity.userId,
        workspaceId,
      },
      "agent-auth: workspace membership lookup failed — denying (fail closed)",
    );
    return { kind: "denied", reason: "membership_lookup_failed" };
  }

  if (!memberships.includes(workspaceId)) {
    log.warn(
      { userId: identity.userId, workspaceId, agentId: identity.agentId },
      "agent-auth: owning user is not a member of the requested workspace — denying (cross-workspace isolation)",
    );
    return { kind: "denied", reason: "not_a_member" };
  }

  // ORG (member) role only — withhold platform_admin. Same boundary the
  // `"agent"` arm of `resolveMcpActorRole` declares. Fails closed: a member-
  // table read error yields `undefined`, so downstream defaults to least
  // privilege (`member`), never escalates.
  const role = await resolveEffectiveRole(undefined, identity.userId, workspaceId);

  const user = createAtlasUser(
    identity.userId,
    "managed",
    identity.label ?? identity.userId,
    {
      ...(role !== undefined ? { role } : {}),
      activeOrganizationId: workspaceId,
      // Minimal, non-secret claims for RLS/audit correlation. No agent JWT or
      // token material is threaded through — only the resolved identifiers.
      claims: {
        agent_auth: true,
        agent_id: identity.agentId,
        active_organization_id: workspaceId,
      } satisfies AgentAuthClaims,
    },
  );

  return { kind: "ok", user, workspaceId };
}
