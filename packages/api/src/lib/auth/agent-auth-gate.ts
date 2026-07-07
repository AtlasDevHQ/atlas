/**
 * Request-time gate for the Agent Auth Protocol surface (#4409 / #2058).
 *
 * The `agentAuth()` plugin is registered UNCONDITIONALLY in `buildPlugins()`
 * (its routes + `agent`/`agentHost`/`agentCapabilityGrant`/`approvalRequest`
 * schema are always present — the same tradeoff `twoFactor`/`passkey` make), so
 * the better-auth build-once singleton never has to be rebuilt to toggle the
 * feature. What *is* toggled — with no redeploy — is whether the reachable HTTP
 * surface answers: this module is the single place that decision is made.
 *
 * Precedent this mirrors: `shouldExposeCanonicalPrompts`
 * (`packages/mcp/src/prompts/gating.ts`) — read a hot-reloadable settings key,
 * fail closed. The catch-all auth router (`api/routes/auth.ts`) and the
 * `/.well-known/agent-configuration` discovery route (`api/routes/well-known.ts`)
 * both consult this before dispatching, and 404 when it says off.
 *
 * Deliberately settings-only imports: the two HTTP surfaces that gate on this
 * must not have to load better-auth (or the agent-auth plugin) to decide
 * whether to 404. No token / agent-session / `/.well-known/agent-configuration`
 * document knowledge lives here — only the on/off decision and the path shape.
 */

import { getSettingLive } from "@atlas/api/lib/settings";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:agent-auth-gate");

/** Settings-registry key (registered in `lib/settings.ts`). */
export const AGENT_AUTH_ENABLED_SETTING = "ATLAS_AGENT_AUTH_ENABLED";

/**
 * Better Auth mounts every plugin endpoint under `/api/auth`. The agent-auth
 * plugin contributes routes under these three functional prefixes plus the one
 * public discovery endpoint. These mirror the plugin's OWN (internal,
 * non-exported) `AGENT_AUTH_PREFIXES` (`/agent/`, `/capability/`, `/host/`) +
 * the `/agent-configuration` discovery path — a hand copy with no compile-time
 * coupling, so a future plugin route outside these would silently escape the
 * gate and be reachable while the feature is off. The
 * `agent-auth-gate.test.ts` contract test guards exactly that: it enumerates
 * every path the real plugin advertises and asserts `isAgentAuthPath` matches
 * each, so a `@better-auth/agent-auth` bump that adds a new route prefix goes
 * RED here instead of opening a hole.
 */
export const AGENT_AUTH_MOUNT = "/api/auth";
const AGENT_AUTH_PREFIXES = [
  `${AGENT_AUTH_MOUNT}/agent/`,
  `${AGENT_AUTH_MOUNT}/capability/`,
  `${AGENT_AUTH_MOUNT}/host/`,
] as const;
/** The plugin's discovery endpoint, mounted under the auth base. */
export const AGENT_AUTH_CONFIGURATION_PATH = `${AGENT_AUTH_MOUNT}/agent-configuration`;

/**
 * True when `path` (a request path like `/api/auth/capability/execute`) targets
 * the agent-auth plugin surface. Used by the catch-all auth router to decide
 * which requests the gate applies to. Exact-match on the discovery path,
 * prefix-match on the three functional groups (so `/agent/device/code`,
 * `/capability/execute`, `/host/enroll`, … are all covered).
 */
export function isAgentAuthPath(path: string): boolean {
  if (path === AGENT_AUTH_CONFIGURATION_PATH) return true;
  return AGENT_AUTH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Coerce a settings string into the boolean the gate needs. Only the exact
 * string `"true"` (case-insensitive, trimmed) enables — every other value,
 * including `undefined`, disables. Fail-safe by construction: a malformed
 * override can never accidentally open the surface.
 */
function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/**
 * Whether the agent-auth surface is enabled — the authoritative, hot-reloaded
 * read. `getSettingLive` refreshes the settings cache from the DB within its
 * short TTL so an operator's toggle takes effect in seconds with no restart.
 *
 * FAIL CLOSED: any resolution error resolves to `false` (off). Enabling an
 * experimental agent-identity surface on a transient settings-DB blip is
 * strictly worse than a brief false-off, so the error path denies.
 *
 * `orgId` selects the workspace tier of the settings precedence chain
 * (workspace override > platform > env > default). Callers that know the
 * resolved workspace (e.g. capability execution) pass it for workspace-override
 * precedence; the raw HTTP surface, which can't know the workspace before the
 * agent JWT is verified without leaking token knowledge into the gate, omits it
 * and gates on the platform default.
 */
export async function isAgentAuthEnabled(orgId?: string): Promise<boolean> {
  try {
    return isTrue(await getSettingLive(AGENT_AUTH_ENABLED_SETTING, orgId));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "agent-auth gate: settings resolution failed — failing closed (off)",
    );
    return false;
  }
}
