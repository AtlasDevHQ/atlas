"use client";

import type { ChatContextWarning } from "@useatlas/types";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Per-message banner for "answer is degraded" signals — one wire shape
 * (`data-context-warning`) covers preflight degradations and plan-budget
 * warnings. Distinct from the destructive ErrorBanner: these are
 * non-fatal signals that the model ran with reduced context (or the
 * workspace is approaching a billing limit), so the treatment is
 * amber/warning, not red/error.
 *
 * Rendered above the assistant turn it belongs to (per-message, not
 * session-wide) so the user can correlate "this answer was degraded"
 * with the specific response.
 */
export function ContextWarningBanner({
  warnings,
}: {
  warnings: ChatContextWarning[];
}) {
  if (warnings.length === 0) return null;

  return (
    <Alert
      data-testid="context-warning-banner"
      data-variant="warning"
      className="mb-2 border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200"
    >
      <AlertTriangle className="text-amber-600 dark:text-amber-400" />
      <AlertTitle>Answer generated with reduced context</AlertTitle>
      <AlertDescription className="text-amber-800/90 dark:text-amber-200/80">
        {warnings.map((w, i) => (
          <div key={`${w.code}-${i}`} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="rounded bg-amber-200/60 px-1.5 py-0.5 font-mono text-[10px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                {w.code}
              </span>
              <span className="text-xs font-medium">{w.title}</span>
            </div>
            {w.detail && <p className="text-xs opacity-90">{w.detail}</p>}
            {w.requestId && (
              <p className="text-[10px] opacity-60">Request ID: {w.requestId}</p>
            )}
          </div>
        ))}
      </AlertDescription>
    </Alert>
  );
}
