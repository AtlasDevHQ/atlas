"use client";

/**
 * Draft-edit undo card (#4555, ADR-0034 Decision 2) — surfaces a bound-editor
 * destructive edit inline in the chat with a one-click Undo.
 *
 * The bound editor tools `removeCard` and `updateCardSql` now apply straight to
 * the caller's draft and return:
 *   {
 *     kind: "removed",     cardId, title, undo: { kind: "restore_card", card }
 *   }
 *   {
 *     kind: "sql_updated", cardId, title, previousSql, newSql,
 *                          undo: { kind: "revert_sql", cardId, sql }
 *   }
 *
 * This card reports what changed and offers Undo. Undo POSTs the inverse edit
 * (`undo`) verbatim to `/api/v1/dashboards/[id]/draft/undo` — an ordinary draft
 * edit; there is no second store. The canvas reflects the edit live already
 * (the tool mutated the draft); Undo just applies the inverse and refetches.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Undo2, Trash2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAtlasConfig } from "@/ui/context";
import { useBoundDraftContext } from "@/ui/components/dashboards/bound-draft-context";
import { getToolResult } from "@/ui/lib/helpers";

// Mirrors the two server envelopes as a discriminated union so a `removed`
// payload can't carry SQL and a `sql_updated` one can't be missing it. `undo`
// is deliberately opaque (the inverse draft edit) — the client echoes it back
// to the server, which is the authority that validates its shape.
type DestructiveEditPayload =
  | { kind: "removed"; cardId: string; title: string; undo: unknown }
  | { kind: "sql_updated"; cardId: string; title: string; previousSql: string; newSql: string; undo: unknown };

function isDestructiveEdit(output: unknown): output is DestructiveEditPayload {
  if (output == null || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  if (typeof o.cardId !== "string" || typeof o.title !== "string") return false;
  if (o.undo == null || typeof o.undo !== "object") return false;
  if (o.kind === "removed") return true;
  if (o.kind === "sql_updated") {
    return typeof o.previousSql === "string" && typeof o.newSql === "string";
  }
  return false;
}

export function DraftEditUndoCard({ part }: { part: unknown }) {
  const output = getToolResult(part);
  if (!isDestructiveEdit(output)) return null;
  return <DraftEditUndoCardInner edit={output} />;
}

function DraftEditUndoCardInner({ edit }: { edit: DestructiveEditPayload }) {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const { dashboardId, onDraftChanged, readOnly } = useBoundDraftContext();
  const [state, setState] = useState<"applied" | "undoing" | "undone" | "error">("applied");
  const [errMessage, setErrMessage] = useState<string | null>(null);

  async function undo() {
    if (state !== "applied") return;
    setState("undoing");
    setErrMessage(null);
    try {
      const response = await fetch(
        `${apiUrl}/api/v1/dashboards/${dashboardId}/draft/undo`,
        {
          method: "POST",
          credentials: isCrossOrigin ? "include" : "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(edit.undo),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch((parseErr: unknown) => {
          // Server returned non-JSON (proxy error page, gateway timeout, HTML
          // 5xx) — log to devtools so a debugging operator sees the parse
          // failure with a correlation hint from the response status.
          console.debug(
            `[draft-edit-undo-card] non-JSON ${response.status} response:`,
            parseErr instanceof Error ? parseErr.message : String(parseErr),
          );
          return {} as Record<string, unknown>;
        });
        const msg = typeof body?.message === "string" ? body.message : "Could not undo the edit.";
        const rid = typeof body?.requestId === "string" ? body.requestId : null;
        setState("error");
        setErrMessage(rid ? `${msg} (request ${rid})` : msg);
        return;
      }
      setState("undone");
      onDraftChanged();
    } catch (err) {
      // A thrown fetch (network / CORS / abort) — log a devtools breadcrumb so
      // the failure is debuggable, then surface a friendly retry message.
      const detail = err instanceof Error ? err.message : String(err);
      console.debug("[draft-edit-undo-card] undo request failed:", detail);
      setState("error");
      setErrMessage("Could not undo the edit. Check your connection and retry.");
    }
  }

  const isRemove = edit.kind === "removed";
  const busy = state === "undoing";
  const undone = state === "undone";

  return (
    <div
      role="region"
      aria-label={isRemove ? "Removed card" : "Rewrote card SQL"}
      data-edit-kind={edit.kind}
      data-edit-state={state}
      className={cn(
        "my-2 rounded-lg border px-3 py-3 text-xs",
        isRemove
          ? "border-red-300/60 bg-red-50/60 dark:border-red-900/50 dark:bg-red-950/20"
          : "border-amber-300/60 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20",
        undone && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <div className={cn("mt-0.5 shrink-0", isRemove ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")}>
          {isRemove ? <Trash2 className="size-3.5" /> : <Pencil className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {isRemove
              ? <>Removed &ldquo;{edit.title}&rdquo;</>
              : <>Rewrote SQL for &ldquo;{edit.title}&rdquo;</>}
          </div>
          <div className="mt-0.5 text-zinc-600 dark:text-zinc-400">
            {isRemove
              ? <>The card is gone from your draft. Undo to restore it.</>
              : <>The card now runs the new query in your draft. Undo to restore the previous SQL.</>}
          </div>
          {edit.kind === "sql_updated" && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Previous</div>
                <pre className="overflow-x-auto rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                  {edit.previousSql}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">New</div>
                <pre className="overflow-x-auto rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                  {edit.newSql}
                </pre>
              </div>
            </div>
          )}

          {/* #4322 — a destructive edit replayed in a read-only History
              transcript is inert: the session is over, so the undo would act
              on the CURRENT draft, not this stale receipt. Show a static note
              instead of a live Undo button. */}
          {readOnly && (
            <div className="mt-2 text-zinc-500" data-testid="undo-readonly">
              {isRemove ? "Removed in this session." : "SQL rewritten in this session."}
            </div>
          )}
          {!readOnly && !undone && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={undo}
                disabled={busy}
                data-testid="undo-button"
              >
                <Undo2 className="mr-1 size-3" aria-hidden="true" />
                Undo
              </Button>
              {errMessage && (
                <span role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {errMessage}
                </span>
              )}
            </div>
          )}
          {undone && (
            <div className="mt-2 text-zinc-500" data-testid="undo-done">
              {isRemove ? "Restored — the card is back in your draft." : "Reverted — the previous SQL is back."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
