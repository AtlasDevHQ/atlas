import type { DeployRegion } from "@/ui/lib/types";

/**
 * True when the deploy region identifies the staging soak environment.
 *
 * The `region` field from `GET /api/v1/health` is optional (self-hosted deploys
 * omit it). A missing region — or any production region (`us` | `eu` | `apac`) —
 * is treated as non-staging so the marker stays hidden outside staging.
 */
export function isStagingRegion(region: DeployRegion | null | undefined): boolean {
  return region === "staging";
}
