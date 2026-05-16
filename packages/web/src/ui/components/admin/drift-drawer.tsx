"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { MutationErrorSurface } from "@/ui/components/admin/mutation-error-surface";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { SemanticDiffResponseSchema } from "@/ui/lib/admin-schemas";
import { DiffCard } from "@/ui/components/admin/diff-card";
import { CheckCircle2, Minus, RefreshCw, Trash2, Plus } from "lucide-react";

interface DriftDrawerProps {
  /**
   * Entity name to show drift for. Matched against the diff payload's
   * `tableDiffs[].table` and `removedTables[]`. `null` keeps the drawer
   * closed without firing the request.
   */
  entityName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Connection alias passed to `/api/v1/admin/semantic/diff`. Defaults to
   * `"default"`; callers thread the active env through once multi-env
   * routing is wired (#2460).
   */
  connection?: string;
  /**
   * Fires after a successful reconcile (#2462). The page consumer refetches
   * the entity list so drift counts + the file tree reflect the new state.
   * Closing the drawer is handled inside the drawer itself.
   */
  onReconciled?: () => void;
  /**
   * Disable the reconcile action buttons (#2462). Page-level callers gate
   * on `useDemoReadonly()` so demo orgs in published mode can't mutate
   * shared content via the drift drawer — mirrors the editor's gating.
   */
  reconcileDisabled?: boolean;
  /** Optional tooltip / a11y hint surfaced when `reconcileDisabled` is true. */
  reconcileDisabledReason?: string;
}

/**
 * Right-side drawer that shows the per-table drift payload for a single
 * entity (#2461) plus three reconcile actions (#2462). #2463 retires the
 * standalone schema-diff page.
 *
 * Reuses the existing `/api/v1/admin/semantic/diff` endpoint and filters
 * client-side rather than extending the API: drift payloads are bounded
 * by the workspace's entity count (10s, not 1000s), so the extra rows are
 * cheap and #2463 retires the standalone diff route anyway. Hoisting
 * filtering server-side here would have made #2463 a backend change too.
 */
export function DriftDrawer({
  entityName,
  open,
  onOpenChange,
  connection = "default",
  onReconciled,
  reconcileDisabled = false,
  reconcileDisabledReason,
}: DriftDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">{entityName ?? "Drift"}</SheetTitle>
          <SheetDescription>Schema drift between database and YAML</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {entityName ? (
            <DriftDrawerBody
              entityName={entityName}
              connection={connection}
              onReconciled={() => {
                onReconciled?.();
                onOpenChange(false);
              }}
              reconcileDisabled={reconcileDisabled}
              reconcileDisabledReason={reconcileDisabledReason}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Body is a separate component so the fetch only fires once `entityName`
 * is set — mounting it conditionally above means React tears the hook
 * tree down when the drawer closes, which short-circuits the request.
 */
function DriftDrawerBody({
  entityName,
  connection,
  onReconciled,
  reconcileDisabled,
  reconcileDisabledReason,
}: {
  entityName: string;
  connection: string;
  onReconciled: () => void;
  reconcileDisabled: boolean;
  reconcileDisabledReason?: string;
}) {
  const { data, loading, error } = useAdminFetch(
    `/api/v1/admin/semantic/diff?connection=${encodeURIComponent(connection)}`,
    {
      schema: SemanticDiffResponseSchema,
      deps: [connection],
    },
  );

  const reconcile = useAdminMutation<{
    ok: boolean;
    action: "sync_yaml" | "remove" | "create_from_db";
    name: string;
    entity: { name: string; yamlContent: string } | null;
  }>({
    method: "POST",
    path: `/api/v1/admin/semantic/entities/${encodeURIComponent(entityName)}/reconcile`,
  });

  if (loading) {
    return <LoadingState message="Loading drift…" />;
  }

  if (error) {
    return <ErrorBanner message={friendlyError(error)} />;
  }

  if (!data) {
    return <ErrorBanner message="No drift data available" />;
  }

  const changed = data.tableDiffs.find((td) => td.table === entityName);
  const isRemoved = data.removedTables.includes(entityName);
  const isNew = data.newTables.includes(entityName);

  const runAction = async (action: "sync_yaml" | "remove" | "create_from_db") => {
    const result = await reconcile.mutate({
      body: { action, connection },
    });
    if (result.ok) onReconciled();
  };

  if (changed) {
    // Auto-expand: the drawer is single-entity, so the collapsed state
    // would just be an extra click. The schema-diff page renders many
    // cards and stays collapsed to keep scroll length sane.
    return (
      <div className="space-y-3">
        <DiffCard diff={changed} defaultOpen />
        <MutationErrorSurface
          error={reconcile.error}
          feature="Semantic Layer"
          variant="inline"
        />
        <ReconcileActions
          actions={["sync_yaml", "remove"]}
          disabled={reconcileDisabled}
          disabledReason={reconcileDisabledReason}
          busyAction={reconcile.saving ? null : null}
          saving={reconcile.saving}
          onRun={runAction}
        />
      </div>
    );
  }

  if (isRemoved) {
    return (
      <div className="space-y-3">
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-50/30 px-3 py-3 text-xs text-red-700 dark:bg-red-950/10 dark:text-red-400"
        >
          <Minus className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The <code className="rounded bg-muted px-1 py-0.5 font-mono">{entityName}</code> entity
            references a table that no longer exists in the database. Remove the stale entity file
            to clear the drift.
          </span>
        </div>
        <MutationErrorSurface
          error={reconcile.error}
          feature="Semantic Layer"
          variant="inline"
        />
        <ReconcileActions
          actions={["remove"]}
          disabled={reconcileDisabled}
          disabledReason={reconcileDisabledReason}
          saving={reconcile.saving}
          onRun={runAction}
        />
      </div>
    );
  }

  if (isNew) {
    return (
      <div className="space-y-3">
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-50/30 px-3 py-3 text-xs text-blue-700 dark:bg-blue-950/10 dark:text-blue-400"
        >
          <Plus className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{entityName}</code> exists in
            the database but has no entity definition. Add it to the semantic layer so the agent
            can query it.
          </span>
        </div>
        <MutationErrorSurface
          error={reconcile.error}
          feature="Semantic Layer"
          variant="inline"
        />
        <ReconcileActions
          actions={["create_from_db"]}
          disabled={reconcileDisabled}
          disabledReason={reconcileDisabledReason}
          saving={reconcile.saving}
          onRun={runAction}
        />
      </div>
    );
  }

  // No matching diff entry — keep the copy descriptive, not affirmative.
  // The page only opens the drawer for drifted rows, so reaching this branch
  // means the entities list and the /diff response disagree (stale state in
  // another tab, a backend warning swallowing tableDiffs, etc.). Logging
  // matches the existing dev-console signal pattern in the semantic page for
  // the same class of disagreement.
  console.warn(
    `drift-drawer: opened for "${entityName}" but no matching diff entry — drift/diff disagreement?`,
  );
  return (
    <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-50/30 px-3 py-3 text-xs text-green-700 dark:bg-green-950/10 dark:text-green-400">
      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
      <span>
        No drift detected for{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">{entityName}</code> in the
        current diff payload.
      </span>
    </div>
  );
}

type ReconcileAction = "sync_yaml" | "remove" | "create_from_db";

const ACTION_LABELS: Record<ReconcileAction, { idle: string; busy: string; icon: typeof RefreshCw }> = {
  sync_yaml: { idle: "Update YAML to match DB", busy: "Updating…", icon: RefreshCw },
  remove: { idle: "Remove orphaned YAML", busy: "Removing…", icon: Trash2 },
  create_from_db: { idle: "Add to semantic layer", busy: "Adding…", icon: Plus },
};

function ReconcileActions({
  actions,
  disabled,
  disabledReason,
  saving,
  onRun,
  busyAction,
}: {
  actions: ReconcileAction[];
  disabled: boolean;
  disabledReason?: string;
  saving: boolean;
  onRun: (action: ReconcileAction) => void;
  busyAction?: ReconcileAction | null;
}) {
  return (
    <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t pt-3">
      {actions.map((action) => {
        const meta = ACTION_LABELS[action];
        const Icon = meta.icon;
        const isBusy = saving && (busyAction === undefined || busyAction === action);
        return (
          <Button
            key={action}
            variant={action === "remove" ? "outline" : "default"}
            size="sm"
            className={
              action === "remove"
                ? "gap-1.5 text-xs text-destructive hover:text-destructive"
                : "gap-1.5 text-xs"
            }
            disabled={disabled || saving}
            title={disabled ? disabledReason : undefined}
            onClick={() => onRun(action)}
          >
            <Icon className="size-3.5" />
            {isBusy ? meta.busy : meta.idle}
          </Button>
        );
      })}
    </SheetFooter>
  );
}
