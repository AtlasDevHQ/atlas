"use client";

/**
 * Member-visible trial banner (#3434).
 *
 * Mounted in the workspace (chat) shell so EVERY member — not just admins —
 * sees the trial clock. Before this, non-admin members first learned their
 * workspace was on a trial when enforcement 403'd their chat on day 14.
 *
 * Data comes from `GET /api/v1/trial` (standardAuth), which serves the
 * *effective* trial end — the same `trial_ends_at` /
 * `createdAt + TRIAL_DAYS` fallback enforcement uses. Renders nothing
 * off-trial, while loading, and on fetch errors (self-hosted, older API).
 *
 * Admins get an Upgrade link into the /admin/billing plan picker (#3418);
 * members get "ask an admin" copy since billing is admin-gated.
 */

import Link from "next/link";
import { AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { useTrialStatus, type TrialInfo } from "@/ui/hooks/use-trial-status";
import { useIsAdmin } from "@/ui/hooks/use-platform-admin-guard";

const MS_PER_DAY = 86_400_000;

export function TrialStatusBanner() {
  const { trial, loading } = useTrialStatus();
  const isAdmin = useIsAdmin();

  if (loading || !trial) return null;
  return <TrialStatusBannerView trial={trial} isAdmin={isAdmin} />;
}

/**
 * Pure presentational half — exported for tests so assertions don't need
 * to mock the fetch hook or the session.
 */
export function TrialStatusBannerView({
  trial,
  isAdmin,
  now,
}: {
  trial: TrialInfo;
  isAdmin: boolean;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
}) {
  const nowMs = now ?? Date.now();
  const endMs = Date.parse(trial.endsAt);
  // Unparseable end fails closed into expired — same posture as the admin
  // TrialCountdownBanner — so the nudge shows rather than silently hiding.
  const expired = trial.expired || !Number.isFinite(endMs) || endMs < nowMs;
  const daysLeft = expired ? 0 : Math.max(1, Math.ceil((endMs - nowMs) / MS_PER_DAY));

  const title = expired
    ? isAdmin
      ? "Your free trial has expired — chat and queries are paused. Upgrade to restore access."
      : "Your workspace's free trial has expired — chat and queries are paused. Ask a workspace admin to upgrade."
    : `Free trial — ends ${formatDate(trial.endsAt)} (${daysLeft} ${daysLeft === 1 ? "day" : "days"} left).`;

  return (
    <div
      role="status"
      data-testid="trial-status-banner"
      data-state={expired ? "expired" : "active"}
      className={cn(
        "flex h-8 shrink-0 items-center justify-between gap-4 px-4 text-xs",
        expired
          ? "bg-red-500/10 text-red-900 dark:bg-red-400/10 dark:text-red-200"
          : "bg-blue-500/10 text-blue-900 dark:bg-blue-400/10 dark:text-blue-200",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {expired ? (
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Clock className="size-3.5 shrink-0" aria-hidden />
        )}
        <p className="truncate font-medium">{title}</p>
      </div>
      {isAdmin && (
        <Button
          size="xs"
          variant={expired ? "default" : "secondary"}
          asChild
          className="shrink-0"
        >
          <Link href="/admin/billing">Upgrade</Link>
        </Button>
      )}
    </div>
  );
}
