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
 * When `getWebOrigin()` is null (single-origin / off-SaaS dev, where the API
 * and web app share a host) the relative `/device` still resolves correctly
 * against that shared origin, so we fall back to it — the device flow's browser
 * approval isn't a SaaS-only path.
 */
export function resolveDeviceVerificationUri(webOrigin: string | null): string {
  return webOrigin ? `${webOrigin}/device` : "/device";
}
