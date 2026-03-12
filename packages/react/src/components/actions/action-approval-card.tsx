"use client";

import { useState } from "react";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import {
  isActionToolResult,
  RESOLVED_STATUSES,
  type ActionStatus,
  type ResolvedStatus,
  type ActionApprovalResponse,
  type ActionToolResultShape,
} from "../../lib/action-types";
import { useAtlasConfig } from "../../context";
import { useActionAuth } from "../../context";
import { LoadingCard } from "../chat/loading-card";
import { ActionStatusBadge } from "./action-status-badge";

/* ------------------------------------------------------------------ */
/*  Safe JSON.stringify helper                                         */
/* ------------------------------------------------------------------ */

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unable to display]";
  }
}

/* ------------------------------------------------------------------ */
/*  Card state machine                                                 */
/* ------------------------------------------------------------------ */

type CardState =
  | { phase: "idle" }
  | { phase: "submitting"; action: "approve" | "deny" }
  | { phase: "resolved"; status: ResolvedStatus; result?: unknown }
  | { phase: "error"; message: string };

/* ------------------------------------------------------------------ */
/*  Border color by status                                             */
/* ------------------------------------------------------------------ */

function borderColor(status: ActionStatus): string {
  switch (status) {
    case "pending_approval":
      return "border-yellow-300 dark:border-yellow-900/50";
    case "approved":
    case "executed":
    case "auto_approved":
      return "border-green-300 dark:border-green-900/50";
    case "denied":
    case "failed":
      return "border-red-300 dark:border-red-900/50";
    default:
      return "border-zinc-200 dark:border-zinc-700";
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ActionApprovalCard({ part }: { part: unknown }) {
  const { apiUrl } = useAtlasConfig();
  const actionAuth = useActionAuth();
  const args = getToolArgs(part);
  const rawResult = getToolResult(part);
  const done = isToolComplete(part);

  const [cardState, setCardState] = useState<CardState>({ phase: "idle" });
  const [open, setOpen] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const [showDenyInput, setShowDenyInput] = useState(false);

  if (!done) return <LoadingCard label="Requesting action approval..." />;

  if (!isActionToolResult(rawResult)) {
    return (
      <div className="my-2 rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        Action result (unexpected format)
      </div>
    );
  }

  const toolResult: ActionToolResultShape = rawResult;

  // Effective status: local optimistic update wins over server result
  const effectiveStatus: ActionStatus =
    cardState.phase === "resolved" ? cardState.status : toolResult.status;

  const isPending = effectiveStatus === "pending_approval" && cardState.phase !== "submitting";
  const isSubmitting = cardState.phase === "submitting";
  const resolvedResult = cardState.phase === "resolved" ? cardState.result : toolResult.result;

  /* ---------------------------------------------------------------- */
  /*  API helpers                                                      */
  /* ---------------------------------------------------------------- */

  async function callAction(endpoint: "approve" | "deny", body?: Record<string, unknown>) {
    if (!actionAuth) {
      console.warn("ActionApprovalCard: No ActionAuthProvider found. API calls will be sent without authentication.");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(actionAuth?.getHeaders() ?? {}),
    };
    const credentials = actionAuth?.getCredentials() ?? "same-origin";

    const res = await fetch(
      `${apiUrl}/api/v1/actions/${toolResult.actionId}/${endpoint}`,
      {
        method: "POST",
        headers,
        credentials,
        body: body ? JSON.stringify(body) : undefined,
      },
    );

    if (res.status === 409) {
      // Already resolved — read current status from response
      let data: ActionApprovalResponse;
      try {
        data = (await res.json()) as ActionApprovalResponse;
      } catch {
        throw new Error("Action was already resolved, but the response could not be read. Refresh the page.");
      }
      const status = typeof data.status === "string" ? data.status as ResolvedStatus : "failed" as ResolvedStatus;
      const label = status.replace(/_/g, " ");
      throw new Error(`This action was already ${label} by another user or policy.`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new Error(`Server responded ${res.status}: ${text}`);
    }

    let data: ActionApprovalResponse;
    try {
      data = (await res.json()) as ActionApprovalResponse;
    } catch {
      throw new Error("Action succeeded, but the response could not be read. Refresh the page.");
    }
    if (typeof data.status !== "string") {
      throw new Error("Action succeeded, but the server returned an invalid status. Refresh the page.");
    }
    setCardState({ phase: "resolved", status: data.status as ResolvedStatus, result: data.result });
  }

  async function handleApprove() {
    setCardState({ phase: "submitting", action: "approve" });
    try {
      await callAction("approve");
    } catch (err) {
      console.error("Action approval failed:", err);
      const message =
        err instanceof TypeError
          ? "Network error — could not reach the server."
          : err instanceof Error
            ? err.message
            : String(err);
      setCardState({ phase: "error", message });
    }
  }

  async function handleDeny() {
    setCardState({ phase: "submitting", action: "deny" });
    try {
      await callAction("deny", denyReason.trim() ? { reason: denyReason.trim() } : undefined);
    } catch (err) {
      console.error("Action approval failed:", err);
      const message =
        err instanceof TypeError
          ? "Network error — could not reach the server."
          : err instanceof Error
            ? err.message
            : String(err);
      setCardState({ phase: "error", message });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className={`my-2 overflow-hidden rounded-lg border ${borderColor(effectiveStatus)} bg-zinc-50 dark:bg-zinc-900`}>
      {/* Header */}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
      >
        <ActionStatusBadge status={effectiveStatus} />
        <span className="flex-1 truncate text-zinc-500 dark:text-zinc-400">
          {toolResult.summary ?? String(args.description ?? "Action")}
        </span>
        <span className="text-zinc-400 dark:text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
      </button>

      {/* Expanded details */}
      {open && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          {toolResult.details && (
            <pre className="mb-2 max-h-48 overflow-auto rounded bg-zinc-100 p-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {safeStringify(toolResult.details)}
            </pre>
          )}
          {resolvedResult != null && (
            <div className="mb-2 rounded bg-green-50 p-2 text-xs text-green-700 dark:bg-green-900/20 dark:text-green-400">
              <span className="font-medium">Result: </span>
              {typeof resolvedResult === "string"
                ? resolvedResult
                : safeStringify(resolvedResult)}
            </div>
          )}
          {toolResult.error && (
            <div className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400">
              <span className="font-medium">Error: </span>
              {toolResult.error}
            </div>
          )}
          {toolResult.reason && RESOLVED_STATUSES.has(effectiveStatus) && (
            <div className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium">Reason: </span>
              {toolResult.reason}
            </div>
          )}
        </div>
      )}

      {/* Approval buttons — only when pending */}
      {(isPending || isSubmitting || cardState.phase === "error") && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          {cardState.phase === "error" && (
            <p className="mb-2 text-xs text-red-600 dark:text-red-400">{cardState.message}</p>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleApprove}
              disabled={isSubmitting}
              className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
            >
              {isSubmitting && cardState.action === "approve" && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              )}
              Approve
            </button>

            {!showDenyInput ? (
              <button
                onClick={() => setShowDenyInput(true)}
                disabled={isSubmitting}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-800 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
              >
                Deny
              </button>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <input
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className="flex-1 rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900 placeholder-zinc-400 outline-none focus:border-red-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-600"
                  disabled={isSubmitting}
                />
                <button
                  onClick={handleDeny}
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40"
                >
                  {isSubmitting && cardState.action === "deny" && (
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  )}
                  Confirm Deny
                </button>
                <button
                  onClick={() => {
                    setShowDenyInput(false);
                    setDenyReason("");
                  }}
                  disabled={isSubmitting}
                  className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-40 dark:hover:text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
