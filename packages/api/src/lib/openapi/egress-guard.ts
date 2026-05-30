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
 * A host-side fetch target was blocked by the SSRF guard. The offending URL is
 * **redacted to its host** (`hostname[:port]`) before it touches the message or
 * the public {@link EgressBlockedError.host} field, because the URL the client
 * builds carries the credential for apiKey-query auth (`?api_key=…`) in its query
 * string — and this error's `message` is propagated to the agent (the
 * `blocked-egress` tool result) and to logs. Redacting at construction keeps the
 * "no secrets in responses / logs" invariant (CLAUDE.md) structural: it is
 * impossible to build an `EgressBlockedError` that leaks a path/query secret.
 */
export class EgressBlockedError extends Error {
  /** Host of the blocked target (`hostname[:port]`), already redacted — never the path/query. */
  readonly host: string;
  constructor(url: string, detail?: string) {
    const host = hostForLog(url);
    super(
      `Refusing to fetch host "${host}": it resolves to a private, loopback, link-local, or internal ` +
        `address (or is not HTTPS). Point the datasource at a public HTTPS host, or set ` +
        `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true to allow internal targets (self-hosted only).` +
        (detail ? ` ${detail}` : ""),
    );
    this.name = "EgressBlockedError";
    this.host = host;
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
 * Request headers forwarded across an origin boundary on a redirect. Everything
 * NOT in this set — `Authorization`, `Cookie`, `Proxy-Authorization`, and any
 * apiKey-header (whatever its configured name) — is dropped on a cross-origin
 * hop so the workspace credential never reaches a host other than the original
 * target. (We strip by allow-list rather than deny-list precisely because the
 * apiKey header name is operator-configurable and unknown to this layer.)
 */
const SAFE_CROSS_ORIGIN_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "user-agent",
]);

/** Origin of `url`, or `""` when unparseable (treated as "not the original origin" — fail-closed). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // intentionally ignored: an unparseable URL has no comparable origin.
    return "";
  }
}

/**
 * Build the `RequestInit` for the next redirect hop, applying the two transforms
 * `fetch`'s own redirect following would do but that `redirect: "manual"` turns
 * off:
 *
 *  - **Credential scoping.** The credential headers are forwarded ONLY when the
 *    next hop is the original target origin (`toOriginalOrigin`); any other
 *    origin gets the {@link SAFE_CROSS_ORIGIN_HEADERS} subset, so a public→public
 *    redirect can't harvest the workspace's `Authorization` / apiKey header.
 *  - **Method/body downgrade (RFC 9110 §15.4).** 303 → GET; a 301/302 on a POST
 *    → GET (universal user-agent behavior); 307/308 preserve. Downgrades are
 *    cumulative (read from `prevInit`); a body is dropped when the method becomes
 *    GET/HEAD. Headers are sourced from `originalInit` so the credential is
 *    re-attached if the chain redirects back to the original origin.
 */
function nextHopInit(
  prevInit: RequestInit,
  originalInit: RequestInit,
  status: number,
  toOriginalOrigin: boolean,
): RequestInit {
  let method = (prevInit.method ?? "GET").toUpperCase();
  let body = prevInit.body;
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    method = "GET";
    body = undefined;
  }
  if (method === "GET" || method === "HEAD") body = undefined;

  const source = new Headers(originalInit.headers);
  const headers = new Headers();
  source.forEach((value, key) => {
    if (toOriginalOrigin || SAFE_CROSS_ORIGIN_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (body === undefined) {
    headers.delete("content-type");
    headers.delete("content-length");
  }

  return { ...originalInit, method, headers, body, redirect: "manual" };
}

/**
 * Fetch `url` with the SSRF guard enforced at every hop. Validates the initial
 * URL, issues the request with `redirect: "manual"`, and on a 3xx re-validates
 * the resolved `Location` host against {@link assertBaseUrlAllowed} *before*
 * following — so a public→internal redirect (the classic SSRF TOCTOU) is
 * rejected even though the up-front check passed. Caps depth at `maxRedirects`.
 *
 * Each redirect hop's `RequestInit` is rebuilt by {@link nextHopInit}: the
 * workspace credential is forwarded only to the original target origin (a
 * cross-origin redirect drops it — `redirect: "manual"` disables the native
 * cross-origin `Authorization` stripping `fetch` would otherwise do), and the
 * method/body follow the RFC 9110 §15.4 redirect rules. The caller's
 * `AbortSignal` (typically `AbortSignal.timeout`) bounds the whole chain. Throws
 * {@link EgressBlockedError} when any hop is blocked or the `Location` is
 * malformed; transport errors propagate from the underlying `fetch`.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const originalOrigin = originOf(url);

  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate immediately before every request leaves the box — this is the
    // "final host" check the up-front guard cannot make for redirect targets.
    assertBaseUrlAllowed(currentUrl);

    const response = await fetchImpl(currentUrl, currentInit);
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

    const toOriginalOrigin = originalOrigin !== "" && originOf(nextUrl) === originalOrigin;
    currentInit = nextHopInit(currentInit, init, response.status, toOriginalOrigin);
    log.debug(
      { from: hostForLog(currentUrl), to: hostForLog(nextUrl), hop, crossOrigin: !toOriginalOrigin },
      "guardedFetch following redirect",
    );
    currentUrl = nextUrl;
  }

  throw new EgressBlockedError(
    currentUrl,
    `Exceeded the redirect cap (${maxRedirects}) — refusing to follow further.`,
  );
}

/**
 * Host-only breadcrumb for logs — never the path/query (which may carry an
 * apiKey-query secret). Exported so every guard consumer logs blocked targets
 * the same way (host only), keeping the "logs never carry a credential"
 * invariant owned by the module that makes the SSRF decision.
 */
export function hostForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // intentionally ignored: log breadcrumb only.
    return "<unparseable>";
  }
}
