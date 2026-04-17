/**
 * Shared helpers for reading the onboarding `ATLAS_DEMO_INDUSTRY` setting.
 *
 * Used by prompt scoping (user-facing list/get) and the admin
 * archive / restore / publish flows to decide whether built-in demo
 * prompt collections for the org's industry are visible or should be
 * cascaded alongside the `__demo__` connection.
 *
 * The read goes through the in-process settings cache. A transient
 * failure surfaces as `{ ok: false, err }` so callers can abort the
 * transaction rather than silently committing with "no industry" —
 * otherwise a read blip would strand demo prompts at `published` while
 * the connection flipped to `archived`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";

const log = createLogger("demo-industry");

/** Canonical key for the onboarding-chosen demo industry. */
export const DEMO_INDUSTRY_SETTING = "ATLAS_DEMO_INDUSTRY";

/**
 * Discriminated outcome of a demo-industry read.
 *
 * `ok: true, value: null` means the row is absent (expected — no demo
 * industry configured for this org). Callers should skip the cascade.
 *
 * `ok: false` means the read itself failed. Callers must NOT treat this
 * as "absent" — archive/publish would otherwise commit with the demo
 * prompts stuck at `published`.
 */
export type ReadDemoIndustryResult =
  | { ok: true; value: string | null }
  | { ok: false; err: Error };

/**
 * Read the org's `ATLAS_DEMO_INDUSTRY` through the settings cache. Sync
 * because `getSettingAuto` is a cache read. The try/catch is defensive —
 * if `getSettingAuto` ever starts throwing, callers get the failure
 * surfaced instead of a silent `null`.
 */
export function readDemoIndustry(
  orgId: string,
  requestId: string,
): ReadDemoIndustryResult {
  try {
    const value = getSettingAuto(DEMO_INDUSTRY_SETTING, orgId) ?? null;
    return { ok: true, value };
  } catch (err) {
    const normalized = err instanceof Error ? err : new Error(String(err));
    log.error(
      { err: normalized.message, orgId, requestId },
      "Failed to read ATLAS_DEMO_INDUSTRY setting",
    );
    return { ok: false, err: normalized };
  }
}
