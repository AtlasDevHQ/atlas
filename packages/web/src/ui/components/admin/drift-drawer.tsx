"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { LoadingState } from "@/ui/components/admin/loading-state";
import { ErrorBanner } from "@/ui/components/admin/error-banner";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { friendlyError } from "@/ui/lib/fetch-error";
import { SemanticDiffResponseSchema } from "@/ui/lib/admin-schemas";
import { DiffCard } from "@/ui/components/admin/diff-card";
import { CheckCircle2, Minus } from "lucide-react";

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
}

/**
 * Right-side drawer that shows the per-table drift payload for a single
 * entity (#2461). Read-only foundation; #2462 adds reconcile actions and
 * #2463 retires the standalone schema-diff page.
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
            <DriftDrawerBody entityName={entityName} connection={connection} />
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
}: {
  entityName: string;
  connection: string;
}) {
  const { data, loading, error } = useAdminFetch(
    `/api/v1/admin/semantic/diff?connection=${encodeURIComponent(connection)}`,
    {
      schema: SemanticDiffResponseSchema,
      deps: [connection],
    },
  );

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

  if (changed) {
    // Auto-expand: the drawer is single-entity, so the collapsed state
    // would just be an extra click. The schema-diff page renders many
    // cards and stays collapsed to keep scroll length sane.
    return (
      <div className="space-y-3">
        <DiffCard diff={changed} defaultOpen />
      </div>
    );
  }

  if (isRemoved) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-50/30 px-3 py-3 text-xs text-red-700 dark:bg-red-950/10 dark:text-red-400"
      >
        <Minus className="mt-0.5 size-3.5 shrink-0" />
        <span>
          The <code className="rounded bg-muted px-1 py-0.5 font-mono">{entityName}</code> entity
          references a table that no longer exists in the database. Consider removing the stale
          entity file.
        </span>
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

