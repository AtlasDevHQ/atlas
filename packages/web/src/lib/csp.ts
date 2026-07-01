/**
 * Content-Security-Policy construction for the per-request nonce posture (#3899).
 *
 * Pure functions, kept out of `proxy.ts` so they're unit-testable without
 * pulling in better-auth/cookies and the proxy's env reads (mirrors how
 * `cookie-prefix.ts` factors out the proxy's other pure helper). `proxy.ts`
 * mints the nonce per request and calls `buildCsp` to assemble the header.
 */

/** `frame-ancestors` is the only directive that varies by route. */
export type FrameAncestors = "'self'" | "*";

/**
 * `'unsafe-eval'` belongs in `script-src` only in dev. Encoded as a named
 * union (not a bare boolean) so the call site reads `"prod"` instead of an
 * opaque `false`, symmetric with `FrameAncestors`.
 */
export type CspEnv = "dev" | "prod";

/**
 * Build the CSP header value for a request.
 *
 * `script-src` is `'self' 'nonce-…' 'strict-dynamic'` — the nonce admits this
 * request's inline/framework scripts, `'strict-dynamic'` lets that nonce'd
 * bootstrap script transitively trust the hashed `/_next/static/*` chunks it
 * loads. Crucially there is NO `'unsafe-inline'`: that token is what an
 * injected inline <script> would otherwise ride to execution, so dropping it
 * is the whole point. `'unsafe-eval'` is added ONLY when `env === "dev"`, where
 * `next dev`/React Refresh use `eval` for HMR and server-error stacks; a
 * production build needs no eval (Recharts draws via d3-shape path math
 * — bundled through victory-vendor — not runtime codegen), so prod omits it
 * and closes the eval/new-Function vector.
 *
 * `style-src` keeps `'unsafe-inline'` (Tailwind + Next inline critical CSS);
 * nonce'ing styles is deliberately out of scope for this change.
 *
 * `frameAncestors` is `*` for the `/shared/:token/embed` view (must frame from
 * any origin so customers can embed shared conversations) and `'self'`
 * everywhere else (clickjacking protection for the app/admin shell). Browsers
 * honor CSP `frame-ancestors` over the `X-Frame-Options: DENY` set in
 * next.config.ts, so the embed path frames while every other path stays denied.
 */
export function buildCsp(
  nonce: string,
  frameAncestors: FrameAncestors,
  env: CspEnv,
): string {
  const allowEval = env === "dev";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${allowEval ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    // `https://challenges.cloudflare.com` frames the Cloudflare Turnstile
    // challenge on the web signup (#4159). Only `frame-src` needs the host here:
    // the Turnstile api.js rides `script-src`'s `'strict-dynamic'` (a nonce'd
    // bundle script injects it), but the challenge iframe is a plain frame the
    // host allowlist must admit — `frame-src 'self'` alone blocks it.
    "frame-src 'self' https://challenges.cloudflare.com",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
  ].join("; ");
}

/**
 * The embed view (`/shared/<token>/embed`, optional trailing slash) inherits
 * the global CSP but widens `frame-ancestors` to `*`. Matched on the resolved
 * pathname only — query/hash are not part of `nextUrl.pathname`.
 */
export function isEmbedRoute(pathname: string): boolean {
  return /^\/shared\/[^/]+\/embed\/?$/.test(pathname);
}

/**
 * The per-route `frame-ancestors` decision — the single gate that widens the
 * clickjacking boundary to `*`. Extracted from the proxy so the security
 * decision (not just the regex and the header builder in isolation) is unit
 * tested: a regression that returned `*` for the app/admin shell would make
 * every admin page embeddable from any origin, and this is what guards it.
 */
export function frameAncestorsFor(pathname: string): FrameAncestors {
  return isEmbedRoute(pathname) ? "*" : "'self'";
}
