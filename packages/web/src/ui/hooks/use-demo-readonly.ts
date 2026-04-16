"use client";

import { useMode } from "@/ui/hooks/use-mode";
import { useModeStatus } from "@/ui/hooks/use-mode-status";

/**
 * Resolves whether demo-seeded admin surfaces should be read-only.
 *
 * Read-only conditions (#1435):
 * - Resolved mode is `published`
 * - Org has an active `__demo__` connection (`demoConnectionActive`)
 *
 * Callers use `readOnly` to disable add/edit/delete buttons on demo content
 * and `demoIndustry` to render dataset-aware subtitles (e.g. "Sentinel
 * Security — 62 entities"). While status is still loading, `readOnly` is
 * false so admin surfaces don't flash disabled on initial paint.
 *
 * The hook intentionally does not infer per-row demo-ness — callers check
 * whether a specific row is demo content (e.g. `id === "__demo__"`,
 * `isBuiltin === true`) and combine with `readOnly`.
 */
export function useDemoReadonly(): {
  readOnly: boolean;
  demoIndustry: string | null;
  demoConnectionActive: boolean;
  loading: boolean;
} {
  const { mode, isLoading: modeLoading } = useMode();
  const { data, loading } = useModeStatus();

  const demoConnectionActive = data?.demoConnectionActive ?? false;
  const demoIndustry = data?.demoIndustry ?? null;
  // Fail-open on first paint so the UI doesn't flash disabled before status
  // resolves. Once `loading` flips to false, the real value takes over.
  const readOnly =
    !modeLoading && !loading && mode === "published" && demoConnectionActive;

  return {
    readOnly,
    demoIndustry,
    demoConnectionActive,
    loading: modeLoading || loading,
  };
}

/**
 * Display labels for demo datasets, matching the onboarding industry slugs
 * written during workspace setup. Kept in sync with `DemoIndicatorChip`.
 *
 * Export a function rather than the map so callers get fail-closed behavior
 * (unknown slug → null) without leaking raw slugs to users.
 */
const DEMO_INDUSTRY_LABELS: Record<string, string> = {
  saas: "SaaS CRM",
  cybersec: "Sentinel Security",
  cybersecurity: "Sentinel Security",
  ecommerce: "NovaMart",
};

/**
 * Display label for a demo industry slug, or null if unknown. Used for
 * dataset-aware subtitles (semantic editor) and indicator chips. The mapping
 * supports both the new `cybersec` slug and the legacy `cybersecurity` one
 * so orgs that onboarded before the rename still render correctly.
 */
export function demoIndustryLabel(industry: string | null | undefined): string | null {
  if (!industry) return null;
  return DEMO_INDUSTRY_LABELS[industry] ?? null;
}
