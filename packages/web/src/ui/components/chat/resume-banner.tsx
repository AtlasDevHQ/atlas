"use client";

import type { RunStatusResponse } from "../../lib/types";
import { History, Clock, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * #3749 — durability affordance shown above the chat composer when a
 * conversation's latest turn is not terminal:
 *
 *   - `running` → the turn was interrupted (a deploy/crash/serverless timeout
 *     killed it mid-flight). Offer a one-click "Resume" that re-enters the agent
 *     loop from its server-side checkpoint and streams the remaining output.
 *   - `parked` → the turn is suspended awaiting a human approval decision. Show a
 *     non-actionable "waiting on approval" state so the conversation reads as
 *     paused, not stuck or errored. It clears (and the turn resumes) once the
 *     approval resolves.
 *
 * Renders nothing for a terminal run (`done`/`failed`), the `none` sentinel, or
 * while the status is still loading — so no affordance appears on a healthy or
 * fresh conversation. Built on the shadcn/ui Alert + Button primitives.
 */
export function ResumeBanner({
  runStatus,
  onResume,
  resuming,
}: {
  /** The latest run status, or `null` while loading / when there's nothing to show. */
  runStatus: RunStatusResponse | null;
  /** Activate the resume — re-enters the interrupted turn. */
  onResume: () => void;
  /** True while a resume stream is in flight (disables the button, shows a spinner). */
  resuming: boolean;
}) {
  if (!runStatus) return null;

  if (runStatus.status === "running") {
    return (
      <Alert
        data-testid="resume-banner"
        data-run-status="running"
        className="mb-2 border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-200"
      >
        <History className="text-blue-600 dark:text-blue-400" />
        <AlertTitle>This turn was interrupted</AlertTitle>
        <AlertDescription className="text-blue-800/90 dark:text-blue-200/80">
          <p>
            The agent stopped mid-response (a deploy, timeout, or connection
            drop). Resume to continue where it left off — completed steps
            won&apos;t re-run.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onResume}
            disabled={resuming}
            className="mt-1 border-blue-300 bg-white text-blue-800 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/40"
            data-testid="resume-button"
          >
            {resuming ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Resuming…
              </>
            ) : (
              <>
                <History className="h-3.5 w-3.5" />
                Resume
              </>
            )}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (runStatus.status === "parked") {
    return (
      <Alert
        data-testid="resume-banner"
        data-run-status="parked"
        className="mb-2 border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200"
      >
        <Clock className="text-amber-600 dark:text-amber-400" />
        <AlertTitle>Waiting on approval</AlertTitle>
        <AlertDescription className="text-amber-800/90 dark:text-amber-200/80">
          <p>
            This turn paused for a reviewer to approve an action. It will
            continue automatically once the request is reviewed — no action
            needed here.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  // Terminal (`done`/`failed`) or `none` — no affordance.
  return null;
}
