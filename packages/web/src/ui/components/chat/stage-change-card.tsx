"use client";

/**
 * Stage change card (#2365) — surfaces a `stage_required` tool result
 * inline in the bound chat drawer with Accept / Discard affordances.
 *
 * The bound editor tools `removeCard` and `updateCardSql` return:
 *   {
 *     kind: "stage_required",
 *     stageId: string,
 *     stageKind: "remove_card" | "edit_sql",
 *     target: { cardId, currentTitle, [currentSql, newSql] },
 *   }
 *
 * This card renders a short summary + Accept / Discard buttons. Clicking
 * either hits `/api/v1/dashboards/[id]/stage/[stageId]/(accept|discard)`
 * and refreshes the dashboard view + the stage overlay list.
 *
 * The ghost overlay itself (strikethrough on the card to be deleted,
 * side-by-side SQL diff on cards to be SQL-edited) is rendered by
 * `<DashboardGrid>` reading from the `/stage` list endpoint — this card
 * just owns the chat-side accept/discard surface.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, X, Trash2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAtlasConfig } from "@/ui/context";
import { useStageContext } from "@/ui/components/dashboards/stage-context";
import { getToolResult } from "@/ui/lib/helpers";

interface StageRequiredPayload {
  kind: "stage_required";
  stageId: string;
  stageKind: "remove_card" | "edit_sql";
  target: {
    cardId: string;
    currentTitle: string;
    currentSql?: string;
    newSql?: string;
  };
}

function isStageRequired(output: unknown): output is StageRequiredPayload {
  if (output == null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return (
    o.kind === "stage_required"
    && typeof o.stageId === "string"
    && typeof o.stageKind === "string"
    && (o.stageKind === "remove_card" || o.stageKind === "edit_sql")
    && o.target != null
    && typeof o.target === "object"
  );
}

export function StageChangeCard({ part }: { part: unknown }) {
  const output = getToolResult(part);
  if (!isStageRequired(output)) return null;
  return <StageChangeCardInner stage={output} />;
}

function StageChangeCardInner({ stage }: { stage: StageRequiredPayload }) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const { dashboardId, onStagesChanged, readOnly } = useStageContext();
  // `null` until the user acts. `accepted` / `discarded` lock the card
  // (the agent won't re-prompt the user; the dashboard refetch surfaces
  // the change).
  const [resolution, setResolution] = useState<"pending" | "accepting" | "discarding" | "accepted" | "discarded" | "error">("pending");
  const [errMessage, setErrMessage] = useState<string | null>(null);

  async function resolveStage(action: "accept" | "discard") {
    if (resolution !== "pending") return;
    setResolution(action === "accept" ? "accepting" : "discarding");
    setErrMessage(null);
    try {
      const response = await fetch(
        `${apiUrl}/api/v1/dashboards/${dashboardId}/stage/${stage.stageId}/${action}`,
        {
          method: "POST",
          credentials: isCrossOrigin ? "include" : "same-origin",
        },
      );
      if (!response.ok) {
        const body = await response.json().catch((parseErr: unknown) => {
          // Server returned non-JSON (proxy error page, gateway timeout,
          // HTML 5xx) — log to devtools so a debugging operator sees the
          // parse failure with a correlation hint from the response status.
          console.debug(
            `[stage-change-card] non-JSON ${response.status} response on ${action}:`,
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
          return {} as Record<string, unknown>;
        });
        const msg = typeof body?.message === "string"
          ? body.message
          : `Could not ${action} the stage.`;
        // Surface `requestId` to the user so support tickets carry a
        // correlation key the API logs can be searched by.
        const rid = typeof body?.requestId === "string" ? body.requestId : null;
        setResolution("error");
        setErrMessage(rid ? `${msg} (request ${rid})` : msg);
        return;
      }
      setResolution(action === "accept" ? "accepted" : "discarded");
      // Tell the parent surfaces (dashboard view + drawer) to refetch.
      onStagesChanged();
    } catch (err) {
      setResolution("error");
      setErrMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const isRemove = stage.stageKind === "remove_card";
  const accepted = resolution === "accepted";
  const discarded = resolution === "discarded";
  const busy = resolution === "accepting" || resolution === "discarding";

  return (
    <div
      role="region"
      aria-label={isRemove ? "Staged card removal" : "Staged SQL rewrite"}
      data-stage-id={stage.stageId}
      data-stage-kind={stage.stageKind}
      data-stage-resolution={resolution}
      className={cn(
        "my-2 rounded-lg border px-3 py-3 text-xs",
        isRemove
          ? "border-red-300/60 bg-red-50/60 dark:border-red-900/50 dark:bg-red-950/20"
          : "border-amber-300/60 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20",
        accepted && "opacity-70",
        discarded && "opacity-50",
      )}
    >
      <div className="flex items-start gap-2">
        <div className={cn("mt-0.5 shrink-0", isRemove ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")}>
          {isRemove ? <Trash2 className="size-3.5" /> : <Pencil className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {isRemove
              ? <>Stage: remove &ldquo;{stage.target.currentTitle}&rdquo;</>
              : <>Stage: rewrite SQL for &ldquo;{stage.target.currentTitle}&rdquo;</>}
          </div>
          <div className="mt-0.5 text-zinc-600 dark:text-zinc-400">
            {isRemove
              ? <>This card is shown with a strikethrough until you decide.</>
              : <>A side-by-side SQL diff overlays this card until you decide.</>}
          </div>
          {!isRemove && stage.target.currentSql && stage.target.newSql && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Current</div>
                <pre className="overflow-x-auto rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                  {stage.target.currentSql}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Proposed</div>
                <pre className="overflow-x-auto rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                  {stage.target.newSql}
                </pre>
              </div>
            </div>
          )}

          {/* #4322 — a staged change replayed in a read-only History
              transcript is inert: the session is over, so there's nothing
              to accept or discard. Show a static note instead of live
              buttons that would POST accept/discard against the current
              draft. */}
          {readOnly && (
            <div className="mt-2 text-zinc-500" data-testid="stage-readonly">
              Staged in this session.
            </div>
          )}
          {!readOnly && resolution !== "accepted" && resolution !== "discarded" && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs"
                onClick={() => resolveStage("accept")}
                disabled={busy}
                data-testid="stage-accept-button"
              >
                <Check className="mr-1 size-3" aria-hidden="true" />
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => resolveStage("discard")}
                disabled={busy}
                data-testid="stage-discard-button"
              >
                <X className="mr-1 size-3" aria-hidden="true" />
                Discard
              </Button>
              {errMessage && (
                <span role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {errMessage}
                </span>
              )}
            </div>
          )}
          {accepted && (
            <div className="mt-2 text-zinc-500" data-testid="stage-accepted">
              Accepted — change applied to your draft.
            </div>
          )}
          {discarded && (
            <div className="mt-2 text-zinc-500" data-testid="stage-discarded">
              Discarded — nothing changed.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
