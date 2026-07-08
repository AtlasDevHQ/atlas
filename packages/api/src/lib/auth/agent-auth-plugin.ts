/**
 * The `agentAuth()` Better Auth plugin config — the Agent Auth Protocol spine
 * (#4409 / #2058, Slice 1).
 *
 * Registered UNCONDITIONALLY in `buildPlugins()` (server.ts), so the plugin's
 * routes and its `agent`/`agentHost`/`agentCapabilityGrant`/`approvalRequest`
 * schema are always present (auto-migrated by Better Auth's `ctx.runMigrations()`
 * at boot, like `twoFactor`/`passkey`/`oauthProvider` — no hand-written Atlas
 * migration). Whether the surface is *reachable* is decided per-request by the
 * `ATLAS_AGENT_AUTH_ENABLED` gate (`agent-auth-gate.ts`), NOT by conditional
 * registration — that is what buys live, no-redeploy toggling of a build-once
 * auth singleton. See the decision comment on #2058.
 *
 * Scope for this slice is deliberately narrow: exactly ONE hand-written
 * capability (NOT the OpenAPI adapter — that is Slice 2 / #4410). Its `onExecute`
 * proxies through the in-process API under a real per-org identity — the Atlas
 * idiom for "call ourselves scoped to a workspace" (ADR-0016: bind an `AtlasUser`
 * and run the lib seam under `withRequestContext`, NOT a loopback HTTP call and
 * NOT a plaintext secret in a header). Org scoping is enforced by the resolved
 * `AtlasUser.activeOrganizationId`, so an agent can never reach another
 * workspace's data.
 *
 * Reversibility: this module and `agent-auth-verifier.ts` are the ONLY places
 * that know about agent sessions / agent JWTs. `onExecute` maps the plugin's
 * `agentSession` into the plugin-agnostic `AgentAuthIdentity` and hands it to the
 * verifier (the sixth `AtlasUser` producer). Nothing downstream — the dispatch
 * gate, RBAC, permissions — learns the agent-auth shape.
 */

import {
  agentAuth,
  agentError,
  AGENT_AUTH_ERROR_CODES,
  type AgentAuthOptions,
  type AgentSession,
  type Capability,
} from "@better-auth/agent-auth";

import { withRequestContext } from "@atlas/api/lib/logger";
import { createLogger } from "@atlas/api/lib/logger";
import { listEntities } from "@atlas/api/lib/semantic/entities";
import {
  resolveAgentAuthActor,
  type AgentAuthIdentity,
} from "@atlas/api/lib/auth/agent-auth-verifier";
import { isAgentAuthEnabled } from "@atlas/api/lib/auth/agent-auth-gate";

const log = createLogger("auth:agent-auth-plugin");

/**
 * The single hand-written capability's name. Exported so the contract test can
 * assert the plugin advertises exactly one capability with this name (Slice 1
 * scope guard against an accidental OpenAPI-adapter expansion).
 */
export const LIST_ENTITIES_CAPABILITY = "list_semantic_entities";

/**
 * Metadata key on the agent record carrying the workspace the agent proposes to
 * act in. Honored only if the agent's owning user is a live member of it (see
 * `resolveAgentAuthActor`) — never claim-trusted.
 */
export const AGENT_WORKSPACE_METADATA_KEY = "workspaceId";

/**
 * The one capability. No `location` → clients bind the JWT `aud` to the
 * discovery document's `default_location` (the `/capability/execute` URL),
 * which is exactly what the plugin's audience check accepts.
 */
const listEntitiesCapability: Capability = {
  name: LIST_ENTITIES_CAPABILITY,
  description:
    "List the semantic-layer entities (tables the analyst agent can query) for the agent's own workspace. Read-only.",
  input: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional case-insensitive substring to filter entities by name, table, or description.",
      },
    },
    additionalProperties: false,
  },
};

/**
 * The complete capability set the spine advertises. Exported so the contract
 * test can assert Slice 1 ships EXACTLY one hand-written capability — a guard
 * against Slice 2's OpenAPI adapter silently expanding the surface here.
 */
export const AGENT_AUTH_CAPABILITIES: readonly Capability[] = [listEntitiesCapability];

/**
 * Read the agent-proposed workspace id off the agent session's metadata,
 * coerced to a non-empty string (metadata values are `string|number|boolean|null`).
 */
function workspaceIdFromSession(session: AgentSession): string | undefined {
  const raw = session.agent.metadata?.[AGENT_WORKSPACE_METADATA_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Map the plugin's verified `agentSession` into the plugin-agnostic identity the
 * verifier consumes. `userId` prefers the canonical owning account
 * (`session.userId`), falling back to the runtime `user.id` for autonomous
 * agents (out of scope for this slice, but the fallback keeps the mapping total).
 */
function toIdentity(session: AgentSession): AgentAuthIdentity {
  return {
    userId: session.userId ?? session.user.id,
    requestedWorkspaceId: workspaceIdFromSession(session),
    agentId: session.agentId,
    label: session.agent.name || session.user.name || undefined,
  };
}

/**
 * `onExecute` for the one capability. The plugin has already verified the agent
 * JWT (signature, `aud`, expiry, jti replay) and the capability grant before we
 * run; we add the Atlas-side per-org identity binding and the org-scoped call.
 */
const onExecute: NonNullable<AgentAuthOptions["onExecute"]> = async ({
  capability,
  agentSession,
  arguments: args,
}) => {
  const identity = toIdentity(agentSession);

  // Resolve the membership-verified per-org identity. Denials (missing/foreign
  // workspace, lookup failure) map to a spec-compliant UNAUTHORIZED envelope —
  // never a partial or cross-workspace result.
  const resolved = await resolveAgentAuthActor(identity);
  if (resolved.kind === "denied") {
    log.warn(
      { agentId: identity.agentId, capability, reason: resolved.reason },
      "agent-auth capability execution denied",
    );
    throw agentError(
      "FORBIDDEN",
      AGENT_AUTH_ERROR_CODES.UNAUTHORIZED,
      resolved.reason === "not_a_member"
        ? "Agent is not authorized for the requested workspace."
        : "Agent identity could not be bound to a workspace.",
    );
  }

  // `workspaceId` is a guaranteed non-empty string on the `ok` arm (encoded in
  // AgentAuthActorResult), so no defensive undefined-check is needed.
  const { user, workspaceId } = resolved;

  // Workspace-override precedence (#4409): the raw HTTP gate checks the platform
  // default; here, with the workspace resolved, honor a per-workspace override.
  // A workspace that has the feature off must not have its data reachable even
  // when the platform default is on. Fail-closed.
  if (!(await isAgentAuthEnabled(workspaceId))) {
    throw agentError(
      "NOT_FOUND",
      AGENT_AUTH_ERROR_CODES.UNAUTHORIZED,
      "Agent Auth is not enabled for this workspace.",
    );
  }

  const filter =
    args && typeof args.filter === "string" ? args.filter : undefined;

  // Bind the per-org identity and run the in-process, org-scoped read. Passing
  // `orgId` explicitly AND binding the identity is belt-and-suspenders: the call
  // is org-scoped by construction, and any deeper RLS-aware read runs under the
  // same bound actor. No secret material is threaded — only the resolved user.
  //
  // The read is wrapped: an UNEXPECTED failure (internal-DB brownout, semantic
  // load/parse error, …) must NOT (a) be silent on Atlas's side, nor (b) let the
  // plugin's default rethrow echo the raw `err.message` back to the agent — the
  // least-trusted actor. Log with a correlatable ref, then throw a generic,
  // non-leaking envelope carrying only that ref. (CLAUDE.md: no silent swallow,
  // no secrets in responses, requestId on 500s.)
  const requestId = crypto.randomUUID();
  try {
    const entities = await withRequestContext({ requestId, user }, () =>
      listEntities({ orgId: workspaceId, mode: "published", ...(filter ? { filter } : {}) }),
    );
    return {
      workspaceId,
      count: entities.length,
      entities: entities.map((e) => ({
        name: e.name,
        table: e.table,
        description: e.description ?? null,
      })),
    };
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        requestId,
        agentId: identity.agentId,
        workspaceId,
      },
      "agent-auth capability execution failed while listing semantic entities",
    );
    throw agentError(
      "INTERNAL_SERVER_ERROR",
      AGENT_AUTH_ERROR_CODES.INTERNAL_ERROR,
      `Failed to list semantic entities (ref ${requestId}). Retry; if it persists, contact your operator.`,
    );
  }
};

/**
 * Build the `agentAuth()` plugin. Kept as a factory (not a module-level
 * singleton) so `buildPlugins()` composes it like every other plugin and tests
 * can construct it in isolation.
 */
export function buildAgentAuthPlugin(): ReturnType<typeof agentAuth> {
  return agentAuth({
    providerName: "Atlas",
    providerDescription:
      "Atlas — deploy-anywhere text-to-SQL data analyst agent (Agent Auth Protocol, experimental).",
    capabilities: [...AGENT_AUTH_CAPABILITIES],
    onExecute,
  });
}
