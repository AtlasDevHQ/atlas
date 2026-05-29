"use client";

import { useState } from "react";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import {
  isRestWriteConfirmResult,
  getRestOperationStatus,
  getRestOperationMessage,
  type RestWriteConfirmResult,
  type RestWriteConfirmResponse,
} from "../../lib/rest-operation-types";
import { useAtlasConfig, useActionAuth } from "../../context";
import { LoadingCard } from "./loading-card";

/* ------------------------------------------------------------------ */
/*  Confirm-before-write card (PRD #2868 slice 5, #2929)               */
/*                                                                     */
/*  Mirrors ActionApprovalCard: the `executeRestOperation` tool stages */
/*  an allowlisted write (it never dispatches it), returning a         */
/*  `needs_confirmation` result. This card renders the banner; Confirm */
/*  POSTs the staged payload to /api/v1/rest-operations/confirm, the   */
/*  ONLY place the write actually fires. Cancel dismisses — the write  */
/*  never happens.                                                     */
/* ------------------------------------------------------------------ */

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unable to display]";
  }
}

type CardState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "executed"; response: RestWriteConfirmResponse }
  | { phase: "cancelled" }
  | { phase: "error"; message: string };

/** The compact line shown for any non-confirmation REST result (reads, errors). */
function RestResultLine({ result }: { result: unknown }) {
  const status = getRestOperationStatus(result) ?? "result";
  const message = getRestOperationMessage(result);
  const isError =
    status === "writes_disabled" ||
    status === "client_error" ||
    status === "http_error" ||
    status === "rate_limited" ||
    status === "invalid_params" ||
    status === "unknown_operation" ||
    status === "no_datasource" ||
    status === "datasource_not_found";
  const tone = isError
    ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400"
    : "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";
  return (
    <div className={`my-2 rounded-lg border px-3 py-2 text-xs ${tone}`}>
      <span className="font-medium">REST {status.replace(/_/g, " ")}</span>
      {message ? <span className="ml-2">{message}</span> : null}
    </div>
  );
}

export function RestWriteConfirmCard({ part }: { part: unknown }) {
  const { apiUrl } = useAtlasConfig();
  const actionAuth = useActionAuth();
  const done = isToolComplete(part);
  const result = getToolResult(part);

  const [cardState, setCardState] = useState<CardState>({ phase: "idle" });

  if (!done) return <LoadingCard label="Preparing REST request..." />;

  // Reads / errors / other statuses render as a compact line, not a banner.
  if (!isRestWriteConfirmResult(result)) {
    return <RestResultLine result={result} />;
  }

  const confirmResult: RestWriteConfirmResult = result;

  async function handleConfirm() {
    if (!actionAuth) {
      console.warn(
        "RestWriteConfirmCard: No AtlasProvider found. The confirm call will be sent without authentication.",
      );
    }
    setCardState({ phase: "submitting" });
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(actionAuth?.getHeaders() ?? {}),
      };
      const credentials = actionAuth?.getCredentials() ?? "same-origin";

      const res = await fetch(`${apiUrl}/api/v1/rest-operations/confirm`, {
        method: "POST",
        headers,
        credentials,
        body: JSON.stringify(confirmResult.confirm),
      });

      if (!res.ok) {
        const text = await res.text().catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          return `<could not read body: ${reason}>`;
        });
        // Surface the server's message when it's a structured error envelope.
        let message = `Server responded ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (typeof parsed.message === "string") message = parsed.message;
        } catch {
          message = `${message}: ${text}`;
        }
        setCardState({ phase: "error", message });
        return;
      }

      let data: RestWriteConfirmResponse;
      try {
        data = (await res.json()) as RestWriteConfirmResponse;
      } catch {
        setCardState({ phase: "error", message: "The write ran, but the response could not be read. Refresh to check." });
        return;
      }
      setCardState({ phase: "executed", response: data });
    } catch (err) {
      const message =
        err instanceof TypeError
          ? "Network error — could not reach the server."
          : err instanceof Error
            ? err.message
            : String(err);
      setCardState({ phase: "error", message });
    }
  }

  const isPending = cardState.phase === "idle" || cardState.phase === "submitting";
  const isSubmitting = cardState.phase === "submitting";

  const borderColor =
    cardState.phase === "executed"
      ? "border-green-300 dark:border-green-900/50"
      : cardState.phase === "error"
        ? "border-red-300 dark:border-red-900/50"
        : cardState.phase === "cancelled"
          ? "border-zinc-200 dark:border-zinc-700"
          : "border-amber-300 dark:border-amber-900/50";

  return (
    <div className={`my-2 overflow-hidden rounded-lg border ${borderColor} bg-zinc-50 dark:bg-zinc-900`}>
      {/* Header — the staged write, always visible. */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {confirmResult.method}
        </span>
        <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">{confirmResult.summary}</span>
      </div>

      {/* Pending: confirm-before-write controls. */}
      {isPending && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
            This will write to <span className="font-medium">{confirmResult.datasourceName}</span>. It has not run
            yet — confirm to proceed, or cancel to leave it un-run.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleConfirm}
              disabled={isSubmitting}
              className="inline-flex items-center gap-1.5 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-amber-500/50 disabled:opacity-40"
            >
              {isSubmitting && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              )}
              Confirm write
            </button>
            <button
              onClick={() => setCardState({ phase: "cancelled" })}
              disabled={isSubmitting}
              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Resolved states. */}
      {cardState.phase === "executed" && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <div
            className={`rounded p-2 text-xs ${
              cardState.response.status === "executed"
                ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
            }`}
          >
            <span className="font-medium">
              {cardState.response.status === "executed"
                ? `Done — HTTP ${cardState.response.httpStatus}`
                : `Upstream error — HTTP ${cardState.response.httpStatus}`}
            </span>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">
              {safeStringify(cardState.response.body)}
            </pre>
          </div>
        </div>
      )}

      {cardState.phase === "cancelled" && (
        <div className="border-t border-zinc-100 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Cancelled — the write was not run.
        </div>
      )}

      {cardState.phase === "error" && (
        <div className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <p className="text-xs text-red-600 dark:text-red-400">{cardState.message}</p>
          <button
            onClick={() => setCardState({ phase: "idle" })}
            className="mt-2 rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
