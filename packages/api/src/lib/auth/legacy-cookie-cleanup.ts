/**
 * Migration cleanup for legacy cross-subdomain auth cookies (#4086).
 *
 * Before ADR-0024 §5, managed-mode Better Auth was configured with
 * `advanced.crossSubDomainCookies`, so the session cookies were minted with a
 * parent-domain attribute (`Domain=useatlas.dev`, stored by the browser as
 * `.useatlas.dev` and sent to every subdomain). ADR-0024 §5 switched to
 * HOST-ONLY cookies (no `Domain`, scoped to the issuing region host) but never
 * CLEARED the parent-domain cookies already sitting in users' browsers.
 *
 * The result, for anyone who logged in before the switch: a request to
 * `api.useatlas.dev` carries TWO `__Secure-<prefix>.session_token` cookies —
 * the stale parent-domain one AND the new host-only one. Better Auth reads the
 * stale shadow first → it points at a dead session → 401. The session survives
 * for exactly one `session.cookieCache.maxAge` window (default 30s) because the
 * `session_data` cache cookie has no parent-domain twin; once it lapses, every
 * authenticated call (`/api/v1/*`, `get-session`) 401s and the app bounces to
 * `/login`. Region-wide, and the parent-domain cookie also leaks to every region
 * edge (`api-eu`/`api-apac`), which independently violates ADR-0024 §5.
 *
 * This module detects the shadow — the session-token cookie name present more
 * than once in the request `Cookie` header — and produces `Set-Cookie`
 * deletions scoped to each parent domain of the request host, so the browser
 * evicts the legacy cookie on its next request to ANY endpoint. It is
 * self-limiting: a clean browser (or one already migrated) has the name at most
 * once, so no deletions are emitted. The deletion targets the parent-domain
 * cookie only (it carries `Domain=`); the host-only cookie Better Auth sets in
 * the same response has no `Domain` and is a distinct cookie, so it is never
 * touched.
 *
 * Pure + dependency-free so it can be unit-tested without standing up Hono or
 * Better Auth; the API wires it as a `/api/*` response middleware.
 */

/** Better Auth session cookie suffixes that can carry a parent-domain shadow. */
const SESSION_COOKIE_SUFFIXES = ["session_token", "session_data"] as const;

/** Cookie name prefixes the browser may attach (RFC 6265bis cookie prefixes). */
const NAME_PREFIXES = ["__Secure-", "__Host-", ""] as const;

/**
 * Parse a raw `Cookie` request header into the list of cookie NAMES present
 * (values dropped). Tolerant of malformed segments. Order preserved.
 */
function cookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return (eq === -1 ? pair : pair.slice(0, eq)).trim();
    })
    .filter(Boolean);
}

/**
 * Count how many cookies in the header are the session-token cookie for this
 * prefix — across all cookie-prefix spellings (`__Secure-`/`__Host-`/none). A
 * count ≥ 2 is the shadow signature: a host-only cookie AND a leftover
 * parent-domain cookie of the same name.
 */
export function countSessionTokenCookies(cookieHeader: string, cookiePrefix: string): number {
  const targets = new Set(NAME_PREFIXES.map((p) => `${p}${cookiePrefix}.session_token`));
  return cookieNames(cookieHeader).filter((name) => targets.has(name)).length;
}

/**
 * The parent domains of `host` that a legacy cross-subdomain cookie could have
 * been scoped to — every domain suffix with ≥ 2 labels, EXCLUDING the full host
 * itself (host-only cookies need no cleanup) and never the bare public-suffix
 * label (a 1-label suffix like `dev`, which browsers reject for `Domain=`).
 *
 * `api.useatlas.dev` → `["useatlas.dev"]`;
 * `api.staging.useatlas.dev` → `["staging.useatlas.dev", "useatlas.dev"]`.
 *
 * This is a deliberately simple label walk, not a Public Suffix List lookup:
 * it over-covers (emits a deletion for each ancestor), and a deletion for a
 * domain the browser holds no cookie on is a harmless no-op. It never emits the
 * full host, so it can't collide with the live host-only cookie.
 */
export function parentCookieDomains(host: string): string[] {
  const hostname = host.trim().toLowerCase().split(":")[0]; // strip any :port
  if (!hostname) return [];
  const labels = hostname.split(".").filter(Boolean);
  // Need ≥ 3 labels for a parent that is itself ≥ 2 labels (e.g. a.b.c → b.c).
  const out: string[] = [];
  // i is the index of the first label of the suffix; suffix must be ≥ 2 labels
  // (labels.length - i >= 2) and must not be the full host (i >= 1).
  for (let i = 1; i <= labels.length - 2; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

/**
 * Build the `Set-Cookie` deletion headers that evict the legacy parent-domain
 * session cookies — or `[]` when no shadow is present (the common, steady-state
 * path). Each deletion matches the legacy cookie by name + `Domain` + `Path`
 * with `Max-Age=0`; `__Secure-`-prefixed names carry `Secure` (required for the
 * browser to accept the deletion of a `__Secure-` cookie).
 *
 * `__Host-` cookies are intentionally never targeted: the `__Host-` prefix
 * forbids a `Domain` attribute, so such a cookie is always host-only and can
 * never be the parent-domain shadow.
 */
export function buildLegacyCookieDeletions(args: {
  cookieHeader: string | null | undefined;
  host: string | null | undefined;
  cookiePrefix: string;
}): string[] {
  const { cookieHeader, host, cookiePrefix } = args;
  if (!cookieHeader || !host) return [];
  // Only act on the shadow signature — keeps this a no-op for clean browsers.
  if (countSessionTokenCookies(cookieHeader, cookiePrefix) < 2) return [];

  const domains = parentCookieDomains(host);
  if (domains.length === 0) return [];

  // Mirror the cookie-prefix spelling the browser actually sent so the deletion
  // name matches exactly. `__Host-` is excluded (it forbids a `Domain`, so it
  // can never be the parent-domain shadow). Prod is `__Secure-` (https); a bare
  // prefix only occurs on http dev, which is never cross-subdomain — but handle
  // it for completeness.
  const present = new Set(cookieNames(cookieHeader));
  const secure = present.has(`__Secure-${cookiePrefix}.session_token`);
  const namePrefix = secure ? "__Secure-" : "";
  const secureAttr = secure ? "; Secure" : "";

  const deletions: string[] = [];
  for (const suffix of SESSION_COOKIE_SUFFIXES) {
    const name = `${namePrefix}${cookiePrefix}.${suffix}`;
    for (const domain of domains) {
      deletions.push(
        `${name}=; Domain=${domain}; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureAttr}`,
      );
    }
  }
  return deletions;
}
