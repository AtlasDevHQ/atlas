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
 * Options for {@link buildAvailableRegions} / {@link buildSignupRegions}.
 *
 * `apiRegion` is a *named* field (not a third positional `string`) on purpose:
 * `defaultRegion` and `apiRegion` are both region ids, and a positional swap of
 * the two would type-check while silently re-introducing #4131 — the staging
 * deploy would serve the prod arms again. The named option makes the call site
 * self-documenting and un-swappable.
 */
export interface RegionPickerOptions {
  /**
   * THIS deploy's own region identity (`getApiRegion()` — `ATLAS_API_REGION`,
   * falling back to `residency.defaultRegion`, else `null`). Drives the
   * home-arm collapse below.
   */
  readonly apiRegion?: string | null;
}

/**
 * Project the configured regions to the signup picker, excluding any region
 * that is not selectable (see {@link isRegionSelectable}).
 *
 * When `apiRegion` (this deploy's own region) names a region that is *not*
 * selectable — the api-staging soak service claims `ATLAS_API_REGION=staging`
 * while building from the shared prod config, so its home arm is the
 * non-selectable `staging` entry — the picker offers ONLY that home arm. Every
 * public arm's `apiUrl` points at a *different* deploy (e.g. `api.useatlas.dev`),
 * so serving them here would cross-origin the account-create POST and dead-end
 * signup (#4131 — the inverse of #3948, where a staging arm leaked INTO the prod
 * picker; here the staging deploy was serving the prod arms instead of its own).
 * For any other case (`apiRegion` selectable, unset, or an unknown id) the full
 * selectable set is returned, unchanged.
 *
 * NOTE: this returns the picker *list* only. The route must pair it with the
 * matching offered default via {@link buildSignupRegions} — see the cross-field
 * invariant documented there.
 */
export function buildAvailableRegions(
  regions: ResidencyConfig["regions"],
  defaultRegion: string,
  opts?: RegionPickerOptions,
): RegionPickerItem[] {
  const apiRegion = opts?.apiRegion;
  // `regions[apiRegion]` types as a non-undefined `RegionConfig` (the repo's
  // tsconfig has `noUncheckedIndexedAccess` off) but is `undefined` at runtime
  // for an unknown id — the `homeCfg &&` guard is LOAD-BEARING (a typo'd
  // `ATLAS_API_REGION` must fall through, not throw on `homeCfg.label`). The
  // `apiRegion &&` guard is also required: it narrows `apiRegion` to `string`.
  const homeCfg = apiRegion ? regions[apiRegion] : undefined;
  if (apiRegion && homeCfg && !isRegionSelectable(homeCfg)) {
    // Sole option, so mark it default — the picker pre-selects the default arm.
    return [{ id: apiRegion, label: homeCfg.label, isDefault: true, apiUrl: homeCfg.apiUrl }];
  }
  return Object.entries(regions)
    .filter(([, cfg]) => isRegionSelectable(cfg))
    // `apiUrl` carries the region→base map to the signup picker so the browser
    // can point its API base at the chosen region before the first identity
    // write (ADR-0024 §4). Passed through verbatim — `undefined` when the region
    // config omits it (single-region / local dev), where no repoint is possible.
    .map(([id, cfg]) => ({ id, label: cfg.label, isDefault: id === defaultRegion, apiUrl: cfg.apiUrl }));
}

/**
 * The full signup region projection the `/regions` route returns: the picker
 * list AND the id the signup page should pre-select.
 *
 * Cross-field invariant (upheld for every non-empty list): the signup page
 * pre-selects the region named by the response `defaultRegion`
 * (`page.tsx` → `setSelected(data.defaultRegion)`), so that id MUST be present in
 * `availableRegions` as the `isDefault` item. `buildAvailableRegions`'s home-arm
 * collapse can return a single arm that is NOT the config `defaultRegion` (the
 * staging deploy offers only `staging` while the config default is `us`) —
 * reporting the unchanged config default there would pre-select a region absent
 * from the list and dead-end the naive Continue click on the "contact support"
 * path (#4131). So the offered default is the marked `isDefault` arm; and if the
 * config default is itself non-selectable or unknown (no arm marked — a misconfig
 * the shared prod config never hits, but config validation permits), the FIRST
 * offered arm is promoted to default rather than echoing the out-of-list config
 * id. Only a genuinely empty selectable set yields a default absent from the
 * (also empty) list — which the page reads as "nothing to pick" and skips.
 */
export function buildSignupRegions(
  regions: ResidencyConfig["regions"],
  defaultRegion: string,
  opts?: RegionPickerOptions,
): { defaultRegion: string; availableRegions: RegionPickerItem[] } {
  const availableRegions = buildAvailableRegions(regions, defaultRegion, opts);
  const marked = availableRegions.find((r) => r.isDefault);
  if (marked) return { defaultRegion: marked.id, availableRegions };
  // No arm is marked default → the config `defaultRegion` is non-selectable or an
  // unknown id (the collapse path didn't fire). Echoing it would name a region
  // ABSENT from the list and re-create the #4131 pre-select dead-end, so promote
  // the first offered arm instead, keeping the invariant (default ∈ list, marked
  // isDefault). The route emits `onboarding.default_region_unselectable` so the
  // misconfig is surfaced rather than silently corrected.
  const [first, ...rest] = availableRegions;
  if (!first) return { defaultRegion, availableRegions };
  return { defaultRegion: first.id, availableRegions: [{ ...first, isDefault: true }, ...rest] };
}
