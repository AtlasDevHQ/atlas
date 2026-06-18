/**
 * OAuth valid-audience derivation for the MCP security spine.
 *
 * Extracted from `auth/server.ts` (#3687) so the boot-time
 * `McpSpineGuardLive` (lib/effect/saas-guards.ts) can assert audiences are
 * derivable WITHOUT pulling the 3k-line Better Auth static graph into the
 * boot-guard module's import path — the same wall-off discipline the rest of
 * the guard family follows. Both `auth/server.ts` (the Better Auth
 * `validAudiences` config) and the boot guard import from here, so the
 * derivation stays a single source of truth.
 *
 * Pure env reads + the `URL` global only — no other module dependencies.
 */

/**
 * Resolve the OAuth `validAudiences` list the issuer accepts when verifying
 * MCP bearer tokens.
 *
 * Resolution priority:
 *   1. ATLAS_OAUTH_VALID_AUDIENCES — comma-separated explicit list.
 *      Used verbatim, no `/mcp` suffix appended (operator owns the
 *      values and may want non-MCP audiences too).
 *   2. ATLAS_PUBLIC_API_URL — same env var well-known.ts and hosted.ts
 *      prefer; we suffix `/mcp` here so the issuer accepts the verifier's
 *      expected audience.
 *   3. BETTER_AUTH_URL — last fallback, `/mcp` suffix appended.
 *
 * Empty string in the env var → no override → fall back to (2)/(3).
 * Returns `[]` when no base URL can be resolved — a SaaS region in that state
 * would verify every MCP token against an empty audience set, which the boot
 * guard treats as an incoherent MCP spine.
 *
 * #2068 — when the resolved base is one of the canonical SaaS regional
 * `api*.useatlas.dev` hosts (`api`, `api-eu`, `api-apac`), the
 * brand-mirror `mcp*.useatlas.dev/mcp` audience is appended so tokens
 * minted post-cutover (advertised on the new canonical hostname)
 * verify here, AND tokens minted just before the cutover (against the
 * regional `<region>.api.useatlas.dev/mcp` host) keep verifying.
 * Self-hosted operators on arbitrary hostnames are unaffected — the
 * mirror only synthesises for `*.useatlas.dev`.
 */
export function resolveOAuthValidAudiences(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.ATLAS_OAUTH_VALID_AUDIENCES?.trim();
  if (explicit) {
    return explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const base =
    env.ATLAS_PUBLIC_API_URL?.trim() || env.BETTER_AUTH_URL?.trim();
  if (!base) return [];
  const trimmed = base.replace(/\/+$/, "");
  const audiences = [`${trimmed}/mcp`];
  const brand = brandMcpAudience(trimmed);
  if (brand) audiences.push(brand);
  return audiences;
}

/**
 * Map a SaaS regional `api*.useatlas.dev` host to its brand
 * counterpart, OR a SaaS brand `mcp*.useatlas.dev` host to its
 * regional counterpart (#2068). The mapping is symmetric so the
 * audience-synthesis invariant doesn't depend on which hostname an
 * operator chose for `ATLAS_PUBLIC_API_URL`:
 *
 *   `api.useatlas.dev`      → `mcp.useatlas.dev`
 *   `api-eu.useatlas.dev`   → `mcp-eu.useatlas.dev`
 *   `api-apac.useatlas.dev` → `mcp-apac.useatlas.dev`
 *   `mcp.useatlas.dev`      → `api.useatlas.dev`
 *   `mcp-eu.useatlas.dev`   → `api-eu.useatlas.dev`
 *   `mcp-apac.useatlas.dev` → `api-apac.useatlas.dev`
 *
 * Anything else (self-hosted, dev, custom-domain SaaS, `apiv2`,
 * `api.eu.useatlas.dev`, etc.) returns null — synthesising a
 * `.useatlas.dev` mirror for an unrelated host would be wrong. The
 * match is anchored on hostname only, so a `BETTER_AUTH_URL` with an
 * unusual port or path still maps cleanly.
 *
 * Symmetry rationale: pre-#2068 every site used the regional host as
 * the canonical base; post-#2068 docs/CLI/registry use the brand. An
 * operator who flips `ATLAS_PUBLIC_API_URL` to the brand (reasonable —
 * it's what the CLI default writes) must still see both audiences
 * synthesised so pre-cutover tokens bound to the regional audience
 * keep verifying. Closing that footgun is cheaper than documenting it
 * as a deployment invariant.
 */
function brandMcpAudience(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: a non-URL `ATLAS_PUBLIC_API_URL` falls
    // back to BETTER_AUTH_URL one layer up; if that fails too, the
    // outer caller returns an empty audience list. Surfacing the
    // parse failure here would double-log on every request.
    return null;
  }
  // Strict match: `api.useatlas.dev` / `api-<region>.useatlas.dev` /
  // `mcp.useatlas.dev` / `mcp-<region>.useatlas.dev`. `apiv2`,
  // `api.eu.useatlas.dev`, etc. are intentionally excluded — we only
  // mirror the documented regional surfaces.
  const matched = url.hostname.match(/^(api|mcp)(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const flipped = matched[1] === "api" ? "mcp" : "api";
  const regionSuffix = matched[2] ?? "";
  return `https://${flipped}${regionSuffix}.useatlas.dev/mcp`;
}
