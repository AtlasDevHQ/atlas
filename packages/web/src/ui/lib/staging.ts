/**
 * True when the deploy region identifies the staging soak environment.
 *
 * The `region` field from `GET /api/health` is optional (self-hosted deploys
 * omit it) and is a raw `string` on the wire, so this accepts `string` rather
 * than the narrower `DeployRegion` union. A missing region — or any production
 * region (`us` | `eu` | `apac`) — is treated as non-staging so the marker stays
 * hidden outside staging.
 */
export function isStagingRegion(region: string | null | undefined): boolean {
  return region === "staging";
}
