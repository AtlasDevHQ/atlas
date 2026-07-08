/**
 * Resolve the `deviceAuthorizationPage` for the Agent Auth Protocol
 * device-authorization approval flow (#4411 / #2058, Slice 3).
 *
 * When an agent requests a capability whose approval strength requires user
 * presence, the `@better-auth/agent-auth` device-code flow returns a
 * `verification_uri` (+ `verification_uri_complete`) pointing at this page. A
 * signed-in human opens it, sees the pending capability request, and
 * approves/denies. The plugin does NOT serve the page — Atlas implements it in
 * `packages/web` at `src/app/agent/approve/page.tsx`.
 *
 * Exactly the same web-origin problem the CLI device flow solves in
 * `resolveDeviceVerificationUri`: the approval page lives on the WEB origin
 * (`app.<env>.useatlas.dev`), but the agent-auth plugin resolves a *relative*
 * `deviceAuthorizationPage` against its own base URL (the API origin), so a bare
 * `"/agent/approve"` becomes `https://api.<env>.useatlas.dev/agent/approve`,
 * which 404s (there is no such route on the API host). Handing the plugin an
 * ABSOLUTE web-app URL makes both `verification_uri` and
 * `verification_uri_complete` (base + `?agent_id=&code=`) resolve to the page
 * that actually renders.
 *
 * `getWebOrigin()` is the same region/env-aware source `resolveDeviceVerificationUri`
 * uses, so the agent-approval URL stays consistent with the CLI `/device` URL
 * across regions. It is null only when NONE of `ATLAS_CORS_ORIGIN`,
 * `BETTER_AUTH_TRUSTED_ORIGINS`, or a region resolves — a genuinely
 * single-origin embedded deploy (e.g. `nextjs-standalone` with the Hono API
 * mounted on the web app's own origin), where the relative `/agent/approve`
 * resolves correctly against that shared origin.
 *
 * The `.replace(/\/+$/, "")` makes the module own its own no-trailing-slash
 * precondition (avoids `//agent/approve`) rather than trusting every caller —
 * even though `getWebOrigin()` already strips trailing slashes today.
 */

/** The web route (in `packages/web`) that renders the approval page. */
export const AGENT_APPROVAL_PATH = "/agent/approve";

export function resolveAgentApprovalPage(webOrigin: string | null): string {
  return webOrigin
    ? `${webOrigin.replace(/\/+$/, "")}${AGENT_APPROVAL_PATH}`
    : AGENT_APPROVAL_PATH;
}
