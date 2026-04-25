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
 * `resolveMcpActor()` is invoked once per MCP process — `bin/serve.ts`
 * resolves it eagerly for stdio (before the first JSON-RPC frame) and
 * for SSE (before any session can be created). The result is threaded
 * into `createAtlasMcpServer({ actor })` so every tool dispatch binds
 * the same identity:
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
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
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

export const MCP_USER_NOT_MEMBER_ERROR =
  "ATLAS_MCP_USER_ID is not a member of ATLAS_MCP_ORG_ID. The bound user must " +
  "have an entry in the `member` table for the bound org. Either add membership " +
  "or rebind to a user that already belongs to this org.";

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
    // Unlike scheduler (orgId derived from a validated task row) and Slack
    // (orgId derived from a validated installation row), MCP wires the two
    // env vars unilaterally — `loadActorUser` will return a fully-formed
    // actor even if the user has no `member` row for the bound org, with
    // `activeOrganizationId` claimed from the env var. That would silently
    // attribute every MCP query to a foreign org in audit + approval
    // routing. Validate explicitly here.
    if (!(await userIsMemberOf(userId, orgId))) {
      throw new Error(MCP_USER_NOT_MEMBER_ERROR);
    }
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

/**
 * Verify the bound user has a `member` row for the bound org. We deliberately
 * do NOT swallow DB errors — a transient internal-DB blip should propagate
 * so MCP fails to boot with the underlying error message rather than
 * silently rejecting a valid binding as "not a member".
 *
 * Reachability note: by the time this runs, `loadActorUser` has already
 * returned a non-null actor, which is only possible when `hasInternalDB()`
 * is true (`packages/api/src/lib/auth/actor.ts:64`). So a `!hasInternalDB()`
 * guard here would be dead code — the realistic mis-config (bound env vars
 * + no DATABASE_URL) is already caught by `MCP_USER_NOT_FOUND_ERROR`.
 */
async function userIsMemberOf(userId: string, orgId: string): Promise<boolean> {
  const rows = await internalQuery<{ exists: number }>(
    `SELECT 1 AS exists FROM member WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1`,
    [userId, orgId],
  );
  return rows.length > 0;
}
