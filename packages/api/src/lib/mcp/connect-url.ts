/**
 * Build the hosted-MCP connect URL for a Workspace.
 *
 * The connect URL is the per-region MCP resource endpoint
 * (`/mcp/{workspaceId}/sse`). An MCP client pointed at it receives a 401 with
 * the RFC 9728 `WWW-Authenticate` resource-metadata pointer, runs Dynamic
 * Client Registration + the authorization-code-with-PKCE flow against the
 * Better Auth OAuth provider, and attaches a normal *hosted* actor to the
 * Workspace. It is the handoff seam the anonymous onboarding caller
 * (`start_trial`, ADR-0018) returns so a brand-new prospect's agent can connect
 * to the Workspace it just provisioned — without leaving the agent.
 *
 * Shared by the `start_trial` MCP tool and any future HTTP onboarding face, so
 * both hand back an identical, canonical connect URL.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("mcp-connect-url");

/**
 * Map a regional `api[-region].useatlas.dev` host onto the public brand host
 * `mcp[-region].useatlas.dev`, so a client that never sees the internal
 * `api.*` URL can still complete DCR. Returns `null` for any host that doesn't
 * match (self-hosted operators on arbitrary hostnames stay on the resolved
 * base).
 *
 * The same `^api(-[a-z0-9]+)?\.useatlas\.dev$` regex is duplicated in three
 * other places — keep all four in lockstep:
 *   - `@atlas/mcp/hosted:brandedMcpHost`
 *   - `packages/api/src/api/routes/well-known.ts:brandedMcpHost`
 *   - `packages/web/src/app/settings/ai-agents/branded-mcp-base.ts:brandedMcpBase`
 */
function brandedMcpHost(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: caller falls back to the trimmed base.
    return null;
  }
  const matched = url.hostname.match(/^api(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const regionSuffix = matched[1] ?? "";
  return `https://mcp${regionSuffix}.useatlas.dev`;
}

/**
 * Resolve the public API base used to address the hosted MCP endpoint.
 * Precedence mirrors `hosted.ts` (`ATLAS_PUBLIC_API_URL` → `BETTER_AUTH_URL`),
 * with a final `baseUrl` override for callers/tests that supply one explicitly.
 */
export function resolveMcpBaseUrl(baseUrl?: string): string {
  const raw =
    baseUrl?.trim() ||
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    "";
  const trimmed = raw.replace(/\/+$/, "");
  return brandedMcpHost(trimmed) ?? trimmed;
}

/**
 * Build the canonical hosted-MCP connect URL for `workspaceId`.
 *
 * @param workspaceId the organization/workspace id (Better Auth `organization.id`)
 * @param baseUrl optional explicit public API base; falls back to env precedence
 */
export function buildMcpConnectUrl(workspaceId: string, baseUrl?: string): string {
  const base = resolveMcpBaseUrl(baseUrl);
  if (!base) {
    // No public API base resolved (ATLAS_PUBLIC_API_URL / BETTER_AUTH_URL both
    // unset). SaaS boot requires these, so this is unreachable in a correctly
    // configured region — but a bare relative `/mcp/{id}/sse` would be the
    // trial's entire payoff handed back unusable. Surface the misconfiguration
    // at provision time rather than as a confusing client-side connect failure.
    log.warn(
      { workspaceId },
      "buildMcpConnectUrl: no public API base resolved — connect URL is relative and unusable; check ATLAS_PUBLIC_API_URL/BETTER_AUTH_URL",
    );
  }
  return `${base}/mcp/${workspaceId}/sse`;
}
