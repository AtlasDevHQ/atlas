/**
 * Resolve the `verificationUri` for the RFC 8628 device-authorization grant
 * (#4043 / ADR-0026 / #4167).
 *
 * `atlas login` prints whatever the deviceAuthorization plugin returns here as
 * the URL a human opens to approve the CLI. The approval page lives in
 * `packages/web` at `src/app/device/page.tsx` — the WEB origin — but Better
 * Auth resolves a *relative* `verificationUri` against its own base URL (the
 * API origin), so a bare `"/device"` becomes `https://api.<env>.useatlas.dev
 * /device`, which 404s (there is no `/device` route on the API host). Handing
 * the plugin an ABSOLUTE web-app URL makes both `verification_uri` and
 * `verification_uri_complete` (base + `?user_code=`) resolve to the page that
 * actually renders.
 *
 * `getWebOrigin()` is the same region/env-aware source `buildClaimUrl` uses
 * (api.*→app.* swap, #3706), so the device URL stays consistent with the
 * `/claim` URL across regions.
 *
 * `getWebOrigin()` is null only when NONE of `ATLAS_CORS_ORIGIN`,
 * `BETTER_AUTH_TRUSTED_ORIGINS`, or a region resolves — i.e. a genuinely
 * single-origin embedded deploy (e.g. `nextjs-standalone` with the Hono API
 * mounted on the web app's own origin), where the relative `/device` resolves
 * correctly against that shared origin. Note the standard split-port
 * `bun run dev` (API :3001, web :3000) is NOT that case: it ships
 * `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000`, so this returns the
 * absolute `http://localhost:3000/device` there too — the relative fallback is
 * for embedded single-origin deploys, not "any local dev".
 *
 * The `.replace(/\/+$/, "")` makes the module own its own no-trailing-slash
 * precondition (avoids `//device`) rather than trusting every caller — even
 * though `getWebOrigin()` already strips trailing slashes today.
 */
export function resolveDeviceVerificationUri(webOrigin: string | null): string {
  return webOrigin ? `${webOrigin.replace(/\/+$/, "")}/device` : "/device";
}
