/**
 * Residency region selectability — the single source of truth for "may a
 * customer be assigned this region?".
 *
 * A region's *existence* in `residency.regions` (load-bearing for the boot guard
 * `RegionGuardLive` + region routing) is independent of its *selectability*. A
 * region flagged `selectable: false` exists for boot/routing but must never be a
 * customer residency choice — neither offered in the signup picker NOR accepted
 * by the assignment write path (#3948 — e.g. the shared-config `staging` arm the
 * api-staging soak service claims). Existence ≠ selectability.
 *
 * Both the read path (this module's `buildAvailableRegions`, used by
 * `GET /api/v1/onboarding/regions` and the admin residency surface) and the
 * write path (`ee/src/platform/residency.ts` `assignWorkspaceRegion`) share
 * `isRegionSelectable` so the two can never drift — closing the UI affordance
 * without closing the actual write would leave the #3948 leak reachable via a
 * direct `POST /assign-region`.
 */
import type { ResidencyConfig } from "@atlas/api/lib/config";
import type { RegionPickerItem } from "@useatlas/types";

type RegionConfig = ResidencyConfig["regions"][string];

/**
 * Whether a region may be chosen by a customer. `true` when the region exists
 * and is not flagged `selectable: false` (an omitted flag defaults to
 * selectable). `undefined` (an unknown region id) is not selectable.
 */
export function isRegionSelectable(region: RegionConfig | undefined): boolean {
  return region !== undefined && region.selectable !== false;
}

/**
 * Project the configured regions to the signup picker, excluding any region
 * that is not selectable (see {@link isRegionSelectable}).
 */
export function buildAvailableRegions(
  regions: ResidencyConfig["regions"],
  defaultRegion: string,
): RegionPickerItem[] {
  return Object.entries(regions)
    .filter(([, cfg]) => isRegionSelectable(cfg))
    .map(([id, cfg]) => ({ id, label: cfg.label, isDefault: id === defaultRegion }));
}
