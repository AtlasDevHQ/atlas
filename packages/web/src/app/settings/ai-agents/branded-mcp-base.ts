/**
 * Map a SaaS regional API base to its `mcp*.useatlas.dev` brand
 * counterpart (#2068). `https://api.useatlas.dev` →
 * `https://mcp.useatlas.dev`, `https://api-eu.useatlas.dev` →
 * `https://mcp-eu.useatlas.dev`, etc. Returns null for any host
 * outside the documented regional pattern (self-hosted, dev,
 * custom-domain SaaS) so those bases pass through unchanged.
 *
 * Mirrors the asymmetric matcher in
 * `packages/api/src/api/routes/well-known.ts:brandedMcpHost` and
 * `packages/mcp/src/hosted.ts:brandedMcpHost`. Keep all three regexes
 * in lockstep — the hosted MCP route's `WWW-Authenticate` and the
 * protected-resource doc must agree on the brand-vs-regional mapping
 * with the wizard's pasted snippet or RFC-8707 token binding fails
 * for the user's freshly-onboarded agent.
 *
 * Lifted out of `connect-wizard.tsx` (#2068 review) for unit testing —
 * a regex drift in this fourth helper would silently render the wrong
 * URL into every SaaS user's pasted config without a unit-test signal,
 * because Next.js inlines `process.env.NEXT_PUBLIC_*` at bundle time
 * and the Playwright run can't reach the SaaS code path.
 */
export function brandedMcpBase(base: string): string | null {
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: a non-URL `apiBase` (window.location
    // origin in dev / Playwright) falls through to as-is — the
    // wizard renders the same string the user is already on.
    return null;
  }
  const matched = url.hostname.match(/^api(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const regionSuffix = matched[1] ?? "";
  return `https://mcp${regionSuffix}.useatlas.dev`;
}
