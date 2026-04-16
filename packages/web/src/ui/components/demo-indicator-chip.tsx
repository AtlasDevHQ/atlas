"use client";

import { Badge } from "@/components/ui/badge";
import { useMode } from "@/ui/hooks/use-mode";
import { useModeStatus } from "@/ui/hooks/use-mode-status";

/**
 * Display labels keyed by the `demo_industry` setting written during
 * onboarding (see `DEMO_INDUSTRIES` in `packages/api/src/api/routes/onboarding.ts:48`).
 *
 * Fail-closed: a new industry without an entry here renders nothing rather
 * than showing a raw slug to users.
 */
const DEMO_INDUSTRY_LABELS: Record<string, string> = {
  saas: "SaaS CRM",
  cybersecurity: "Sentinel Security",
  ecommerce: "NovaMart",
};

/**
 * Subtle indicator shown to non-admin users when the org's workspace is
 * running on a demo dataset. Admins already see the amber developer banner
 * when toggled into developer mode — the chip keeps those surfaces distinct.
 *
 * Renders nothing when:
 * - Mode status is loading or unavailable
 * - The user is an admin (they have the developer banner)
 * - The org has no active `__demo__` connection
 * - The org never selected a demo industry (null slug)
 * - The industry slug isn't in `DEMO_INDUSTRY_LABELS` (fail-closed)
 */
export function DemoIndicatorChip() {
  const { isAdmin, isLoading: modeLoading } = useMode();
  const { data, loading } = useModeStatus();

  if (loading || modeLoading) return null;
  if (isAdmin) return null;
  if (!data?.demoConnectionActive) return null;

  const industry = data.demoIndustry;
  if (!industry) return null;

  const label = DEMO_INDUSTRY_LABELS[industry];
  if (!label) return null;

  return (
    <Badge
      variant="secondary"
      className="h-5 border-zinc-200 bg-zinc-100 px-1.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
      aria-label={`Demo dataset: ${label}`}
      title={`You are viewing the ${label} demo dataset`}
    >
      {label} demo
    </Badge>
  );
}
