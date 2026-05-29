/**
 * `network-allowlist` — layer 0 of the OpenAPI-agent safety stack (#2927).
 *
 * Translates the set of *server-resolved* REST Datasource base URLs into the
 * `@vercel/sandbox` {@link SandboxNetworkPolicy} that bounds which hosts the
 * agent's sandbox-Python can reach AT ALL — before any operation-level check
 * (slice 5) runs. On SaaS the per-request Firecracker microVM starts `deny-all`;
 * this module narrows it to exactly the installed Datasource host(s) and nothing
 * else.
 *
 * SECURITY — read before editing:
 *
 *  - **No prompt input.** Every parameter here is a server-resolved base URL
 *    (the install's `openapi_url` / `base_url_override`). There is deliberately
 *    NO `code` / prompt parameter anywhere in this module, so a malicious agent
 *    emission cannot reach these functions and cannot widen the allowlist. That
 *    is the structural guarantee behind "a prompt cannot inject or widen it" —
 *    enforced by the type signatures, not by a runtime check that could regress.
 *
 *  - **Fail-closed.** An empty allowlist maps to `"deny-all"`, never
 *    `"allow-all"`. A datasource that fails to resolve contributes no host, so
 *    the sandbox keeps zero egress.
 *
 *  - **Per-request, never cached.** Nothing here is module-global or memoized:
 *    the policy is computed fresh from the caller's per-request datasource set
 *    every call, so tenant A's policy can never carry tenant B's host.
 *
 *  - **No credentials in the policy.** This layer ONLY opens egress to a host;
 *    it deliberately does NOT inject any credential (no request transformer). A
 *    network policy injects auth on every method, but the slice-3 contract is
 *    read-only — and read-only cannot be enforced for in-sandbox authenticated
 *    HTTP, because untrusted agent code that can reach an HTTP client can issue
 *    any method. So the credential stays out of the sandbox path entirely: the
 *    authenticated read path remains the host-side `executeRestOperation` tool
 *    (server-side credential + server-side read-only enforcement). The bounded
 *    in-sandbox composition client is deferred to a later slice that mediates
 *    read-only at a method-aware host-side point. See
 *    `docs/architecture/sandbox.mdx`.
 *
 * Self-hosted note: the sidecar backend has no `networkPolicy` equivalent (its
 * network is open). This module is only consulted on the Vercel-sandbox path.
 */

/**
 * The `@vercel/sandbox` network-policy type, derived from the SDK's own
 * `Sandbox.updateNetworkPolicy` parameter rather than imported by name. The
 * exported type name has drifted across `@vercel/sandbox` versions (1.9.0
 * exports `NetworkPolicy`; other versions name the same shape differently),
 * but the method signature is stable — so deriving the type here keeps this
 * module compiling against whatever version is installed, while staying
 * exactly the shape `Sandbox.create({ networkPolicy })` / `updateNetworkPolicy`
 * accept.
 */
type VercelSandboxInstance = InstanceType<(typeof import("@vercel/sandbox"))["Sandbox"]>;
export type SandboxNetworkPolicy = Parameters<
  VercelSandboxInstance["updateNetworkPolicy"]
>[0];

/**
 * Extract the lowercased hostname (no scheme, port, userinfo, or path) from a
 * URL string, or `null` when it is not a parseable http(s) URL. The hostname is
 * the granularity `@vercel/sandbox` matches on (`allow: ["crm.example.com"]`),
 * so a non-standard port on the base URL does not affect the match.
 */
export function hostFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // intentionally ignored: an unparseable URL contributes no host — the
    // caller drops it (and logs), which narrows the allowlist (fail-closed).
    return null;
  }
  // Only http(s) datasources are reachable from the sandbox; anything else
  // (file:, data:, ftp:, …) contributes no host — fail-closed.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  return host.length > 0 ? host : null;
}

/**
 * Compute the egress host allowlist for a set of base URLs: the de-duplicated,
 * sorted set of hostnames. Unparseable / non-http(s) URLs are dropped (the
 * caller is expected to log the drop) — returning a partial list is the
 * fail-closed choice, since a malformed URL must never widen the surface.
 *
 * This is THE allowlist the security tests assert on: it depends only on the
 * server-resolved base URLs, so it is structurally immune to prompt injection
 * (there is no code parameter to inject through) and is recomputed per request
 * (no shared state), so it cannot leak one tenant's host into another's policy.
 */
export function computeNetworkAllowlist(baseUrls: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const url of baseUrls) {
    const host = hostFromUrl(url);
    if (host) hosts.add(host);
  }
  return [...hosts].toSorted();
}

/**
 * Build the `@vercel/sandbox` {@link SandboxNetworkPolicy} for an allowlist.
 *
 * - **Empty allowlist → `"deny-all"`** — fail-closed: no datasource means no
 *   egress.
 * - **Non-empty → record form**, one host → empty rule list (allowed, no
 *   transform). Any host not listed is denied by `@vercel/sandbox`'s
 *   deny-by-default. No credential transformer is attached (see the module
 *   header) — egress is opened, auth is not.
 */
export function networkPolicyFromAllowlist(
  allowlist: readonly string[],
): SandboxNetworkPolicy {
  if (allowlist.length === 0) return "deny-all";

  // Record form, one entry per host, each with an empty rule list. No
  // transformer = no credential injected into the network path.
  const allow: Record<string, never[]> = {};
  for (const host of allowlist) {
    allow[host] = [];
  }
  return { allow } satisfies SandboxNetworkPolicy;
}
