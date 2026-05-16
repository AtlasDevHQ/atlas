"use client";

import { useState } from "react";
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
   * Entity name to show drift for. Matched against `tableDiffs[].table` /
   * `removedTables[]` / `newTables[]`. `null` keeps the drawer closed.
   */
  entityName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Connection alias for `/api/v1/admin/semantic/diff`. */
  connection?: string;
  /** Fires after a successful reconcile so the page can refetch entities. */
  onReconciled?: () => void;
  /** Disables the action buttons (e.g. demo-readonly orgs in published mode). */
  reconcileDisabled?: boolean;
  reconcileDisabledReason?: string;
}

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

// Split so the diff fetch only fires when `entityName` is non-null —
// mounting conditionally above tears the hook tree down on close.
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

  // Tracks which action is in-flight so the right button shows busy copy
  // when the panel renders two (the `changed` case).
  const [busyAction, setBusyAction] = useState<ReconcileAction | null>(null);

  const runAction = async (action: ReconcileAction) => {
    setBusyAction(action);
    try {
      const result = await reconcile.mutate({ body: { action, connection } });
      if (result.ok) onReconciled();
      // !result.ok → <MutationErrorSurface> below renders the error.
    } finally {
      setBusyAction(null);
    }
  };

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

  if (changed) {
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
          busyAction={busyAction}
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
          busyAction={busyAction}
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
          busyAction={busyAction}
          onRun={runAction}
        />
      </div>
    );
  }

  // Drift/diff disagreement — the page only opens the drawer for drifted
  // rows, so this branch usually means stale state in another tab.
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
  busyAction,
  onRun,
}: {
  actions: ReconcileAction[];
  disabled: boolean;
  disabledReason?: string;
  busyAction: ReconcileAction | null;
  onRun: (action: ReconcileAction) => void;
}) {
  const anyBusy = busyAction !== null;
  return (
    <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t pt-3">
      {actions.map((action) => {
        const meta = ACTION_LABELS[action];
        const Icon = meta.icon;
        const isBusy = busyAction === action;
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
            disabled={disabled || anyBusy}
            title={disabled ? disabledReason : undefined}
            onClick={() => onRun(action)}
            data-testid={`drift-action-${action}`}
          >
            <Icon className="size-3.5" />
            {isBusy ? meta.busy : meta.idle}
          </Button>
        );
      })}
    </SheetFooter>
  );
}
