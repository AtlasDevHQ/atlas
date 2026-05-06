/**
 * Shared SaaS-hostname helpers for the canonical Atlas regional/brand
 * surfaces (`api.useatlas.dev`, `api-eu.useatlas.dev`,
 * `api-apac.useatlas.dev`, `mcp.useatlas.dev`, `mcp-eu.useatlas.dev`,
 * `mcp-apac.useatlas.dev`).
 *
 * Two callers need to map between the brand and regional surface; their
 * needs differ in direction:
 *
 *   - Audience accept-lists (issuer + verifier) need symmetry: a token
 *     bound to either name must verify regardless of which canonical
 *     hostname an operator picked for `ATLAS_PUBLIC_API_URL`. Use
 *     `flipUseatlasHost`.
 *   - Outbound surfaces (protected-resource doc, `WWW-Authenticate`
 *     resource_metadata, 421 misrouting body, in-product wizard
 *     snippet) advertise the brand surface and never the underlying
 *     regional infra. Use `brandUseatlasHost` — asymmetric on purpose,
 *     `null` for inputs already on the brand surface so the caller's
 *     `?? trimmed` fallback emits the brand verbatim.
 *
 * Both helpers share one regex anchored on `*.useatlas.dev` so a future
 * regional addition (e.g. `mcp-mena`) is a one-line change here, not
 * five. Self-hosted operators on arbitrary hostnames are unaffected —
 * helpers return `null` for any host outside the documented regional
 * pattern. `apiv2`, `api.eu.useatlas.dev`, `api.useatlas.dev.evil.test`
 * and similar anti-patterns are intentionally rejected.
 *
 * The match is anchored on hostname only, so a `BETTER_AUTH_URL` with
 * an unusual port or path still maps cleanly.
 */

const SAAS_HOST_PATTERN = /^(api|mcp)(-[a-z0-9]+)?\.useatlas\.dev$/;

interface ParsedSaasHost {
  readonly side: "api" | "mcp";
  readonly regionSuffix: string;
}

function parseSaasHost(base: string): ParsedSaasHost | null {
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: non-URL input is one of the documented
    // fallback paths (window.location.origin in dev, an env var the
    // operator typo'd) — caller's `?? trimmed` handles it.
    return null;
  }
  const matched = url.hostname.match(SAAS_HOST_PATTERN);
  if (!matched) return null;
  return {
    side: matched[1] as "api" | "mcp",
    regionSuffix: matched[2] ?? "",
  };
}

/**
 * Symmetrically flip between regional `api*.useatlas.dev` and brand
 * `mcp*.useatlas.dev` hosts:
 *
 *     api.useatlas.dev      ↔  mcp.useatlas.dev
 *     api-eu.useatlas.dev   ↔  mcp-eu.useatlas.dev
 *     api-apac.useatlas.dev ↔  mcp-apac.useatlas.dev
 *
 * Returns null for anything outside the documented regional surfaces.
 * Use this for audience accept-lists where both directions must be
 * accepted regardless of operator config — issuer-side
 * `validAudiences` and verifier-side `verifyOptions.audience`. The
 * caller appends the result alongside the original to form the
 * accept-list.
 */
export function flipUseatlasHost(base: string): string | null {
  const parsed = parseSaasHost(base);
  if (!parsed) return null;
  const flipped = parsed.side === "api" ? "mcp" : "api";
  return `https://${flipped}${parsed.regionSuffix}.useatlas.dev`;
}

/**
 * Map a SaaS regional `api*.useatlas.dev` host to its
 * `mcp*.useatlas.dev` brand counterpart. Returns null for any host
 * outside the regional pattern — including brand hosts themselves,
 * which are already canonical and need no rewrite. The caller falls
 * back to the trimmed base in that case (`brandUseatlasHost(x) ?? x`).
 *
 * Asymmetric on purpose: this is the "always advertise the brand"
 * helper used by outbound surfaces. The corresponding symmetric
 * helper is `flipUseatlasHost`.
 */
export function brandUseatlasHost(base: string): string | null {
  const parsed = parseSaasHost(base);
  if (!parsed || parsed.side !== "api") return null;
  return `https://mcp${parsed.regionSuffix}.useatlas.dev`;
}
