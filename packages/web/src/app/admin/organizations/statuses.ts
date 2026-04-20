// Display-only helpers for workspace status + plan-tier badges, mirrored
// after `roles.ts` (member roles) but for the workspace-level enums.
//
// Both helpers are **fail-safe** — unknown server values render a neutral
// fallback badge with a one-time `console.warn` rather than crashing the
// row. This protects the operator surface against server drift (a future
// plan tier added before the web bundle ships, an enterprise enum value
// leaking into the community type).
//
// Pair `statusBadge` with the `WorkspaceStatus` enum from `@useatlas/types`
// (`active`, `suspended`, `deleted`); pair `planBadge` with `PlanTier`
// (`free`, `trial`, `starter`, `pro`, `business`).

import { CheckCircle2, Pause, Trash2, CreditCard } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { WORKSPACE_STATUSES, PLAN_TIERS } from "@useatlas/types";
import type { WorkspaceStatus, PlanTier } from "@useatlas/types";

interface BadgeDescriptor {
  readonly Icon: LucideIcon;
  readonly className: string;
  readonly label: string;
}

const STATUS_BADGES: Record<WorkspaceStatus, BadgeDescriptor> = {
  active: {
    Icon: CheckCircle2,
    className:
      "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400",
    label: "Active",
  },
  suspended: {
    Icon: Pause,
    className:
      "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400",
    label: "Suspended",
  },
  deleted: {
    Icon: Trash2,
    className:
      "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400",
    label: "Deleted",
  },
};

const PLAN_BADGES: Record<PlanTier, BadgeDescriptor> = {
  free: {
    Icon: CreditCard,
    className: "border-muted-foreground/30 text-muted-foreground",
    label: "Free",
  },
  trial: {
    Icon: CreditCard,
    className:
      "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400",
    label: "Trial",
  },
  starter: {
    Icon: CreditCard,
    className: "border-primary/50 text-primary",
    label: "Starter",
  },
  pro: {
    Icon: CreditCard,
    className:
      "border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-400",
    label: "Pro",
  },
  business: {
    Icon: CreditCard,
    className:
      "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400",
    label: "Business",
  },
};

const NEUTRAL_BADGE: BadgeDescriptor = {
  Icon: CheckCircle2,
  className: "border-muted-foreground/30 text-muted-foreground",
  label: "Unknown",
};

// Module-scoped so repeated renders of the same unknown value only warn
// once per session. Tests that assert multiple unknown-value branches in a
// single file MUST call `__resetWarnSets()` in `beforeEach` — Bun's
// isolated runner resets module state between files, not between tests.
const warnedUnknownStatuses = new Set<string>();
const warnedUnknownPlans = new Set<string>();

/** Test hook: clear dedup sets so each test starts from a known state. */
export function __resetWarnSets(): void {
  warnedUnknownStatuses.clear();
  warnedUnknownPlans.clear();
}

/**
 * Resolve icon + classes for a workspace status. Unknown values render a
 * neutral badge labeled with the raw value (so operators can read what came
 * back) and emit one `console.warn` per unknown value per session.
 */
export function statusBadge(status: string): BadgeDescriptor {
  if ((WORKSPACE_STATUSES as readonly string[]).includes(status)) {
    return STATUS_BADGES[status as WorkspaceStatus];
  }
  if (!warnedUnknownStatuses.has(status)) {
    warnedUnknownStatuses.add(status);
    console.warn(
      `[admin/organizations] Unknown workspace status "${status}" — rendering neutral fallback. Investigate server drift or update WORKSPACE_STATUSES.`,
    );
  }
  return { ...NEUTRAL_BADGE, label: status || "Unknown" };
}

/**
 * Resolve icon + classes for a plan tier. Same fail-safe semantics as
 * `statusBadge` — unknown tiers render a neutral badge with a one-time
 * warning so a server-side enum addition doesn't break the operator UI.
 */
export function planBadge(planTier: string): BadgeDescriptor {
  if ((PLAN_TIERS as readonly string[]).includes(planTier)) {
    return PLAN_BADGES[planTier as PlanTier];
  }
  if (!warnedUnknownPlans.has(planTier)) {
    warnedUnknownPlans.add(planTier);
    console.warn(
      `[admin/organizations] Unknown plan tier "${planTier}" — rendering neutral fallback. Investigate server drift or update PLAN_TIERS.`,
    );
  }
  return { ...NEUTRAL_BADGE, label: planTier || "Unknown" };
}
