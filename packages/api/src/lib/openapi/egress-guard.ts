/**
 * `openapi-egress-guard` — the single SSRF chokepoint for every host-side
 * OpenAPI fetch (#3006). The sandbox network allowlist protects the in-sandbox
 * Python path, but the spec probe and operation execution run *host-side*,
 * outside it — so a workspace admin (or a public spec that declares an internal
 * `servers[0].url`) could otherwise aim a credentialed request at cloud metadata
 * (`169.254.169.254`) or internal services. This module is the one place that
 * decision is made, shared by install, rediscover, resolve, and execution:
 *
 *   - {@link assertBaseUrlAllowed} — throws {@link EgressBlockedError} for any
 *     URL that {@link isSafeExternalUrl} rejects (private/loopback/link-local/
 *     CGNAT IP, internal hostname, non-HTTPS). The one validation chokepoint.
 *   - {@link guardedFetch} — fetches with `redirect: "manual"` and re-validates
 *     every `Location` host before following, capping redirect depth. Closes the
 *     TOCTOU gap where a guarded public URL 302-redirects to an internal host.
 *
 * **Operator opt-in.** Self-hosted operators legitimately connect internal
 * OpenAPI services. Rather than silently exempting all non-SaaS deploys (the
 * pre-#3006 behavior, which left self-hosted unprotected by default), the guard
 * is ON everywhere and an operator opts OUT explicitly via
 * `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true`. Fail-closed by default; the escape
 * hatch is a deliberate, auditable env flag — never an implicit deploy-mode skip.
 *
 * Plain `Error` subclass (not `Data.TaggedError`): like {@link OpenApiProbeError}
 * this is plain-async machinery whose callers branch on `instanceof` outside any
 * Effect pipeline (the install handler → 400, the probe → `OpenApiProbeError`,
 * the client → `OpenApiClientError`).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { isSafeExternalUrl } from "@atlas/api/lib/sandbox/validate";

const log = createLogger("openapi.egress-guard");

/** Max redirect hops {@link guardedFetch} follows before giving up. */
export const MAX_REDIRECTS = 5;

/**
 * A host-side fetch target was blocked by the SSRF guard. `url` is the offending
 * URL (or redirect target) — safe to log, never contains a credential (auth is
 * carried in headers, not the URL, except apiKey-query, which is on the request
 * the caller built, not this string).
 */
export class EgressBlockedError extends Error {
  readonly url: string;
  constructor(url: string, detail?: string) {
    super(
      `Refusing to fetch "${url}": it resolves to a private, loopback, link-local, or internal ` +
        `address (or is not HTTPS). Point the datasource at a public HTTPS host, or set ` +
        `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true to allow internal targets (self-hosted only).` +
        (detail ? ` ${detail}` : ""),
    );
    this.name = "EgressBlockedError";
    this.url = url;
  }
}

/**
 * Whether the operator has opted out of the egress guard. Read at call time (not
 * module load) so tests and runtime config changes take effect without a restart.
 * Any value other than the literal `"true"` keeps the guard ON (fail-closed).
 */
export function isInternalEgressAllowed(): boolean {
  return process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS === "true";
}

/**
 * The single SSRF chokepoint. Throws {@link EgressBlockedError} unless `url` is a
 * safe public target — or the operator opt-out is set. Used at install,
 * rediscover, resolve, and (via {@link guardedFetch}) immediately before every
 * host-side fetch.
 */
export function assertBaseUrlAllowed(url: string): void {
  if (isInternalEgressAllowed()) return;
  if (!isSafeExternalUrl(url)) {
    throw new EgressBlockedError(url);
  }
}

/** Options for {@link guardedFetch}. */
export interface GuardedFetchOptions {
  /** `fetch` override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Max redirect hops to follow. Defaults to {@link MAX_REDIRECTS}. */
  readonly maxRedirects?: number;
}

/** 3xx statuses that carry a `Location` we would follow. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch `url` with the SSRF guard enforced at every hop. Validates the initial
 * URL, issues the request with `redirect: "manual"`, and on a 3xx re-validates
 * the resolved `Location` host against {@link assertBaseUrlAllowed} *before*
 * following — so a public→internal redirect (the classic SSRF TOCTOU) is
 * rejected even though the up-front check passed. Caps depth at `maxRedirects`.
 *
 * The same `init` (method, headers, body, signal) is replayed on each hop: the
 * security goal is host re-validation, not byte-perfect HTTP redirect method
 * semantics. The caller's `AbortSignal` (typically `AbortSignal.timeout`) bounds
 * the whole chain. Throws {@link EgressBlockedError} when any hop is blocked;
 * transport errors propagate from the underlying `fetch`.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate immediately before every request leaves the box — this is the
    // "final host" check the up-front guard cannot make for redirect targets.
    assertBaseUrlAllowed(currentUrl);

    const response = await fetchImpl(currentUrl, { ...init, redirect: "manual" });
    if (!isRedirectStatus(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response; // a 3xx with no Location — nothing to follow.

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch (err) {
      // A malformed Location is not actionable and not safe to chase — fail closed.
      throw new EgressBlockedError(
        location,
        `Upstream redirected to a malformed Location (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    log.debug({ from: safeUrlForLog(currentUrl), to: safeUrlForLog(nextUrl), hop }, "guardedFetch following redirect");
    currentUrl = nextUrl;
  }

  throw new EgressBlockedError(
    currentUrl,
    `Exceeded the redirect cap (${maxRedirects}) — refusing to follow further.`,
  );
}

/** Host-only breadcrumb for logs — never the path/query (which may carry an apiKey-query secret). */
function safeUrlForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // intentionally ignored: log breadcrumb only.
    return "<unparseable>";
  }
}
