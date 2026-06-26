/**
 * Whether the web app talks to its API on a SEPARATE origin — SaaS serves the
 * app from `app.useatlas.dev` and the API from `api[-region].useatlas.dev`,
 * signalled by a build-time `NEXT_PUBLIC_ATLAS_API_URL`.
 *
 * This reads ONLY the env (not `@/lib/api-url`'s mutable regional override), so
 * a server-side caller — the proxy — gets a stable, request-independent answer.
 * `@/lib/api-url.isCrossOrigin()` is the *client* counterpart: it folds in the
 * runtime regional override and is the one components should use. The split
 * matters for the proxy: in a cross-origin deploy the session cookie is
 * host-only on the regional API host (ADR-0024 §5) and is never delivered to
 * this app origin, so the proxy must NOT perform a server-side cookie-presence
 * check (it would see no cookie for everyone and loop authenticated users to
 * /login). Auth UX in that mode is the client-side `AuthGuard`'s job (a real
 * `useSession()` validation), with the API as the enforcement boundary.
 */
export function isCrossOriginApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.NEXT_PUBLIC_ATLAS_API_URL?.trim();
}
