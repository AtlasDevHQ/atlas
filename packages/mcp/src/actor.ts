/**
 * MCP actor binding (#1858).
 *
 * Mirrors the F-54 (scheduler) / F-55 (Slack) binding pattern from PR #1860
 * for the MCP transport. The agent loop's approval gate
 * (`ee/src/governance/approval.ts → checkApprovalRequired`) keys on
 * `RequestContext.user.activeOrganizationId`. Without a bound user the
 * defensive `identityMissing` branch fires and every MCP query fails closed
 * with "approve via the Atlas web app" — a message that doesn't apply to
 * the MCP transport because the caller has no Atlas session.
 *
 * `resolveMcpActor()` runs once at MCP server boot and produces an
 * `AtlasUser` to bind on every tool dispatch:
 *
 *  - **Bound transport** (both `ATLAS_MCP_USER_ID` + `ATLAS_MCP_ORG_ID`
 *    set) — resolves the workspace identity via `loadActorUser` so
 *    approval rules apply to MCP queries with a real requester. Required
 *    when the deployment has any enabled approval rule.
 *
 *  - **Trusted transport** (neither env var set, no enabled approval
 *    rule, or no internal DB) — returns a synthetic `system:mcp` actor.
 *    Pre-existing behaviour (queries proceed) is preserved; the actor
 *    exists so `audit_log.user_id` still attributes the call. Mirrors
 *    the F-27 `system:audit-purge-scheduler` convention.
 *
 *  - **Mis-configured** — env vars unset while approval rules exist,
 *    only one of the two env vars set, or `ATLAS_MCP_USER_ID` resolves
 *    no row. Throws at startup so MCP fails to boot rather than silently
 *    failing every query (the previous behaviour: defensive check
 *    tripped per-query with a chat-app-shaped error).
 */

import { Effect } from "effect";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { loadActorUser } from "@atlas/api/lib/auth/actor";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("mcp:actor");

const SYSTEM_MCP_ACTOR_ID = "system:mcp";

export const MCP_BINDING_ERROR_MESSAGE =
  "MCP transport has no actor binding but the deployment has approval rules. " +
  "Set ATLAS_MCP_USER_ID + ATLAS_MCP_ORG_ID at MCP startup, or scope your approval rules to other surfaces.";

export const MCP_PARTIAL_BINDING_ERROR =
  "MCP actor binding requires BOTH ATLAS_MCP_USER_ID and ATLAS_MCP_ORG_ID. " +
  "Set both, or unset both for trusted-transport mode.";

export const MCP_USER_NOT_FOUND_ERROR =
  "ATLAS_MCP_USER_ID resolves no row in the internal DB. The user may have been " +
  "deleted or removed from the org. Recreate the binding under a current Atlas user.";

export async function resolveMcpActor(): Promise<AtlasUser> {
  const userId = process.env.ATLAS_MCP_USER_ID;
  const orgId = process.env.ATLAS_MCP_ORG_ID;

  // Partial binding is always a configuration error — fail loud rather than
  // pick one half of the binding and proceed (which would either short-
  // circuit the approval gate or produce a synthetic actor with the wrong
  // org claim).
  if (Boolean(userId) !== Boolean(orgId)) {
    throw new Error(MCP_PARTIAL_BINDING_ERROR);
  }

  if (userId && orgId) {
    const actor = await loadActorUser(userId, orgId);
    if (!actor) throw new Error(MCP_USER_NOT_FOUND_ERROR);
    log.info(
      { userId: actor.id, orgId, mode: actor.mode },
      "MCP bound to workspace identity",
    );
    return actor;
  }

  // Trusted-transport mode: both env vars unset. Only safe when no rule
  // can match — otherwise the per-query defensive check would trip on
  // every call and the operator wouldn't see the configuration mistake
  // until a user reports a broken MCP session.
  if (await rulesExist()) {
    throw new Error(MCP_BINDING_ERROR_MESSAGE);
  }

  log.info({}, "MCP starting in trusted-transport mode (system:mcp)");
  return createAtlasUser(SYSTEM_MCP_ACTOR_ID, "simple-key", SYSTEM_MCP_ACTOR_ID, {
    role: "member",
    claims: { sub: SYSTEM_MCP_ACTOR_ID, transport: "mcp" },
  });
}

async function rulesExist(): Promise<boolean> {
  if (!hasInternalDB()) return false;
  try {
    const { anyApprovalRuleEnabled } = await import("@atlas/ee/governance/approval");
    return await Effect.runPromise(anyApprovalRuleEnabled());
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "anyApprovalRuleEnabled lookup failed at MCP startup — assuming rules exist (fail-closed)",
    );
    // Fail-closed: when we cannot determine rule existence we require the
    // operator to bind explicitly. The alternative (assume none) is the
    // exact silent-bypass shape this binding exists to prevent.
    return true;
  }
}
