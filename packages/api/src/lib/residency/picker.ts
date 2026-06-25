/**
 * Signup data-residency picker projection.
 *
 * Maps the configured residency regions to the customer-facing list returned by
 * `GET /api/v1/onboarding/regions` (the `/signup/region` step). Regions flagged
 * `selectable: false` are excluded: they exist in the config for the boot guard
 * (`RegionGuardLive`) and region routing, but must never be a selectable
 * residency choice for real signups (#3948 — e.g. the shared-config `staging`
 * arm the api-staging soak service claims). Existence ≠ selectability, so the
 * filter lives here at the picker layer rather than by removing the region from
 * the config (which would crash-loop the staging service — see #3948 → #3951).
 */
import type { ResidencyConfig } from "@atlas/api/lib/config";

export interface AvailableRegion {
  id: string;
  label: string;
  isDefault: boolean;
}

/**
 * Project the configured regions to the signup picker, excluding any region
 * marked `selectable: false`. A region with `selectable` omitted is selectable
 * (default `true`).
 */
export function buildAvailableRegions(
  regions: ResidencyConfig["regions"],
  defaultRegion: string,
): AvailableRegion[] {
  return Object.entries(regions)
    .filter(([, cfg]) => cfg.selectable !== false)
    .map(([id, cfg]) => ({ id, label: cfg.label, isDefault: id === defaultRegion }));
}
