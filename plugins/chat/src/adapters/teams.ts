/**
 * Teams adapter configuration for the Chat SDK bridge.
 *
 * Thin wrapper around `@chat-adapter/teams`'s `createTeamsAdapter()` for
 * import isolation. Passes through adapter credentials without modification.
 * The Chat SDK adapter handles Bot Framework JWT verification, activity
 * parsing, @mention stripping, and Adaptive Card formatting internally.
 */

import { createTeamsAdapter as createChatTeamsAdapter } from "@chat-adapter/teams";
import type { TeamsAdapterConfig } from "../config";

/**
 * Create a Chat SDK Teams adapter from Atlas plugin config.
 *
 * The Chat SDK adapter auto-verifies incoming Bot Framework JWTs,
 * strips @mention entities, and converts responses to Adaptive Cards.
 * Tenant restriction is enforced by setting `appTenantId` + `appType: "SingleTenant"`.
 */
export function createTeamsAdapter(config: TeamsAdapterConfig) {
  return createChatTeamsAdapter({
    appId: config.appId,
    appPassword: config.appPassword,
    appTenantId: config.tenantId,
    appType: config.tenantId ? "SingleTenant" : "MultiTenant",
  });
}
