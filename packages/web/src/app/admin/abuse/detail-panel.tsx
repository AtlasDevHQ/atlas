"use client";

import { Fragment } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { AbuseDetailSchema } from "@/ui/lib/admin-schemas";
import type {
  AbuseCounters,
  AbuseInstance,
  AbuseThresholdConfig,
} from "@/ui/lib/types";
import { levelBadge, triggerLabel } from "./helpers";

// Keep the inline-expand layout usable when the panel is still loading.
const SKELETON_HEIGHT = "min-h-40";

/**
 * "147 / 100 queries in 60s" — formats a counter against its threshold so the
 * operator can see how close to the line the workspace is without reaching
 * for a calculator.
 */
function CounterRow({
  label,
  value,
  threshold,
  suffix,
  over,
}: {
  label: string;
  value: string;
  threshold: string;
  suffix?: string;
  over: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs tabular-nums">
        <span className={over ? "font-semibold text-destructive" : "text-foreground"}>
          {value}
        </span>
        <span className="text-muted-foreground"> / {threshold}</span>
        {suffix && <span className="text-muted-foreground"> {suffix}</span>}
      </span>
    </div>
  );
}

function CountersSection({
  counters,
  thresholds,
}: {
  counters: AbuseCounters;
  thresholds: AbuseThresholdConfig;
}) {
  const errorRatePctDisplay =
    counters.errorRatePct !== null ? counters.errorRatePct.toFixed(0) : null;
  const errorRateThresholdPct = (thresholds.errorRateThreshold * 100).toFixed(0);

  return (
    <section>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Current counters
      </h4>
      <div className="space-y-1.5 rounded-md border bg-background p-3">
        <CounterRow
          label="Queries"
          value={counters.queryCount.toString()}
          threshold={thresholds.queryRateLimit.toString()}
          suffix={`in ${thresholds.queryRateWindowSeconds}s`}
          over={counters.queryCount > thresholds.queryRateLimit}
        />
        <CounterRow
          label="Error rate"
          value={errorRatePctDisplay !== null ? `${errorRatePctDisplay}%` : "—"}
          threshold={`${errorRateThresholdPct}%`}
          over={
            counters.errorRatePct !== null &&
            counters.errorRatePct / 100 > thresholds.errorRateThreshold
          }
        />
        <CounterRow
          label="Unique tables"
          value={counters.uniqueTablesAccessed.toString()}
          threshold={thresholds.uniqueTablesLimit.toString()}
          over={counters.uniqueTablesAccessed > thresholds.uniqueTablesLimit}
        />
        <div className="flex items-baseline justify-between gap-2 pt-1">
          <span className="text-xs text-muted-foreground">Consecutive escalations</span>
          <span className="font-mono text-xs tabular-nums">{counters.escalations}</span>
        </div>
      </div>
      {counters.errorRatePct === null && counters.queryCount > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Error rate is evaluated after 10 queries in the current window.
        </p>
      )}
    </section>
  );
}

function TimelineSection({
  title,
  instance,
  emptyMessage,
}: {
  title: string;
  instance: AbuseInstance;
  emptyMessage: string;
}) {
  if (instance.events.length === 0) {
    return (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        <p className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
          {emptyMessage}
        </p>
      </section>
    );
  }
  return (
    <section>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <ol className="space-y-1.5 rounded-md border bg-background p-3">
        {instance.events.map((e) => (
          <li
            key={e.id}
            className="flex items-baseline gap-2 text-xs"
          >
            <span className="w-16 shrink-0 text-muted-foreground">
              <RelativeTimestamp iso={e.createdAt} />
            </span>
            <span className="shrink-0">{levelBadge(e.level)}</span>
            <span className="flex-1 truncate text-muted-foreground">
              {e.message || triggerLabel(e.trigger)}
            </span>
            {e.actor !== "system" && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {e.actor}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function PriorInstancesSection({ instances }: { instances: AbuseInstance[] }) {
  if (instances.length === 0) {
    return (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Prior flag history
        </h4>
        <p className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
          First time this workspace has been flagged.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Prior flag history ({instances.length})
      </h4>
      <ul className="space-y-1.5 rounded-md border bg-background p-3">
        {instances.map((inst, i) => (
          <li
            key={`${inst.startedAt}-${i}`}
            className="flex items-baseline gap-2 text-xs"
          >
            <span className="shrink-0">{levelBadge(inst.peakLevel)}</span>
            <span className="flex-1 text-muted-foreground">
              {inst.events.length} event{inst.events.length === 1 ? "" : "s"}
            </span>
            <span className="shrink-0 text-muted-foreground">
              <RelativeTimestamp iso={inst.startedAt} />
              {inst.endedAt && (
                <Fragment>
                  {" → "}
                  <RelativeTimestamp iso={inst.endedAt} />
                </Fragment>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Lazy-loaded investigation panel for a single flagged workspace.
 *
 * Owns its own `useAdminFetch` so expanding workspace A doesn't refetch
 * workspace B's detail. The Reinstate mutation lives here too — it's an
 * action *after* investigation, not the only affordance the row offered
 * before the revamp.
 */
export function AbuseDetailPanel({
  workspaceId,
  onReinstated,
}: {
  workspaceId: string;
  onReinstated: () => void;
}) {
  const { data, loading, error, refetch } = useAdminFetch(
    `/api/v1/admin/abuse/${encodeURIComponent(workspaceId)}/detail`,
    { schema: AbuseDetailSchema },
  );

  const reinstate = useAdminMutation({
    method: "POST",
    // Intentionally NOT refetching our own detail after reinstate — the
    // workspace's level flips to "none" server-side, so the detail endpoint
    // would 404 and flash an error banner before the parent's `onReinstated`
    // refetch removes the row and unmounts this panel.
    invalidates: onReinstated,
  });

  async function handleReinstate() {
    // Errors surface via `reinstate.error` in the banner below. On success the
    // parent's `onReinstated` refetch drops this workspace from the list and
    // unmounts the panel.
    await reinstate.mutate({
      path: `/api/v1/admin/abuse/${encodeURIComponent(workspaceId)}/reinstate`,
    });
  }

  if (loading && !data) {
    return (
      <div
        className={`flex items-center justify-center gap-2 rounded-md border bg-background p-4 text-sm text-muted-foreground ${SKELETON_HEIGHT}`}
      >
        <Loader2 className="size-4 animate-spin" />
        Loading investigation detail...
      </div>
    );
  }

  if (error) {
    // 404 `not_flagged` fires on a benign race — the workspace was reinstated
    // from another tab (or aged out of the in-memory window) between the
    // list fetch and this detail fetch. Don't funnel it through the generic
    // `friendlyError()` mapping, which rewrites all 404s to
    // "This feature is not enabled on this server." — that's correct for the
    // top-level SaaS-gated page, and actively misleading here. Render the
    // server's own message and refresh the parent list instead of showing a
    // Retry button that will 404 again.
    if (error.code === "not_flagged") {
      return (
        <div className="rounded-md border bg-background p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <p className="font-medium">Workspace is no longer flagged</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                It was reinstated elsewhere or returned to normal. The list may be out of date.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={onReinstated}>
              Refresh list
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="font-medium text-destructive">Couldn't load investigation detail</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{friendlyError(error)}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CountersSection counters={data.counters} thresholds={data.thresholds} />
      <TimelineSection
        title="Current flag timeline"
        instance={data.currentInstance}
        emptyMessage="No persisted events yet for this flag. Recent events will appear here once they are written to the audit trail."
      />
      <div className="lg:col-span-2">
        <PriorInstancesSection instances={data.priorInstances} />
      </div>

      {reinstate.error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive lg:col-span-2"
        >
          {friendlyError(reinstate.error)}
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 lg:col-span-2">
        <p className="text-xs text-muted-foreground">
          Reinstating resets counters. If the pattern continues the workspace will be
          flagged again.
        </p>
        <Button
          onClick={handleReinstate}
          disabled={reinstate.saving}
          size="sm"
        >
          {reinstate.saving ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 size-3" />
          )}
          Reinstate workspace
        </Button>
      </footer>
    </div>
  );
}
