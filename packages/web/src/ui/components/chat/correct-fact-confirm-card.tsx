"use client";

import { useState } from "react";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import {
  isCorrectFactConfirmResult,
  describeCorrectionOutcome,
  getCorrectFactError,
  type CorrectFactConfirmResult,
  type CorrectFactConfirmResponse,
} from "../../lib/correct-fact-types";
import { useAtlasConfig, useActionAuth } from "../../context";
import { LoadingCard } from "./loading-card";

/* ------------------------------------------------------------------ */
/*  Correction confirm card (#5496, ADR-0036 §T9)                      */
/*                                                                     */
/*  Mirrors RestWriteConfirmCard: the `correct_fact` tool STAGES a     */
/*  correction (it never applies one), returning a `needs_confirmation`*/
/*  result. This card renders the banner; Confirm POSTs the staged     */
/*  payload to /api/v1/brain-corrections/confirm, the ONLY place a     */
/*  chat-staged correction actually fires. Cancel dismisses — the      */
/*  correction never happens.                                          */
/*                                                                     */
/*  The card is the human's act. Until #5496 the agent's own call was  */
/*  treated as the act, and a sentence in the tool description was the */
/*  only thing asking it to check first.                               */
/* ------------------------------------------------------------------ */

/** The amber "this will change the brain" verbs vs the confirming ones. */
const DESTRUCTIVE_VERBS = new Set(["retract", "supersede"]);

type CardState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "applied"; response: CorrectFactConfirmResponse }
  | { phase: "cancelled" }
  /**
   * `retrySafe` gates the re-arming "Try again" button. It is `true` ONLY when
   * the correction provably did NOT land — a 4xx, where the server rejected
   * before applying the verb — so re-confirming cannot double-write.
   *
   * ⚠️ A retry re-POSTs the SAME token, and the token is single-use: the server
   * burns the nonce on the attempt, not on success. So a "Try again" after a
   * rejected confirm is refused as a replay, by design — spending the nonce on
   * the attempt is what stops one confirmation being fired against many states.
   * The button therefore only ever helps for a transient rejection, and the
   * honest path when it fails is to ask Atlas to stage the correction again.
   * That is what the copy says.
   */
  | { phase: "error"; message: string; retrySafe: boolean };

/** The compact line shown for any non-confirmation `correct_fact` result (refusals, errors). */
function CorrectFactErrorLine({ result }: { result: unknown }) {
  const message = getCorrectFactError(result);
  return (
    <div className="my-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
      <span className="font-medium">Correction not staged</span>
      {message ? <span className="ml-2">{message}</span> : null}
    </div>
  );
}

export function CorrectFactConfirmCard({ part }: { part: unknown }) {
  const { apiUrl } = useAtlasConfig();
  const actionAuth = useActionAuth();
  const done = isToolComplete(part);
  const result = getToolResult(part);

  const [cardState, setCardState] = useState<CardState>({ phase: "idle" });

  if (!done) return <LoadingCard label="Preparing correction..." />;

  // Refusals / degraded paths render as a compact line, not a banner.
  if (!isCorrectFactConfirmResult(result)) {
    return <CorrectFactErrorLine result={result} />;
  }

  const confirmResult: CorrectFactConfirmResult = result;
  const isDestructive = DESTRUCTIVE_VERBS.has(confirmResult.verb);

  async function handleConfirm() {
    if (!actionAuth) {
      console.warn(
        "CorrectFactConfirmCard: No AtlasProvider found. The confirm call will be sent without authentication.",
      );
    }
    setCardState({ phase: "submitting" });
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(actionAuth?.getHeaders() ?? {}),
      };
      const credentials = actionAuth?.getCredentials() ?? "same-origin";

      const res = await fetch(`${apiUrl}/api/v1/brain-corrections/confirm`, {
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
        let message = `Server responded ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (typeof parsed.message === "string") message = parsed.message;
        } catch (err) {
          // Non-JSON error body — fall back to surfacing the raw text.
          console.debug("CorrectFactConfirmCard: error response body was not JSON", {
            reason: err instanceof Error ? err.message : String(err),
          });
          message = `${message}: ${text}`;
        }
        // Every 4xx here is raised BEFORE the verb runs (no_workspace 400,
        // invalid/expired/replayed token 400, not-authorized 403, not-found 404,
        // target-state refusal 409, body validation 422) — so the correction
        // provably never landed. A 5xx is raised at or after the transaction, so
        // the correction may already have applied.
        const retrySafe = res.status < 500;
        if (!retrySafe) {
          message = `${message} — the correction may have been applied. Ask Atlas to check the fact before trying again.`;
        }
        setCardState({ phase: "error", message, retrySafe });
        return;
      }

      let data: CorrectFactConfirmResponse;
      try {
        data = (await res.json()) as CorrectFactConfirmResponse;
      } catch (err) {
        // A 2xx means the server committed the correction — only the response
        // body was unreadable. It DID run; do not offer a re-arming retry.
        console.debug("CorrectFactConfirmCard: could not parse 2xx confirm response body", {
          reason: err instanceof Error ? err.message : String(err),
        });
        setCardState({
          phase: "error",
          retrySafe: false,
          message:
            "The correction was applied, but its result could not be read. Ask Atlas to check the fact — do not re-run it.",
        });
        return;
      }
      setCardState({ phase: "applied", response: data });
    } catch (err) {
      // fetch() rejected. A TypeError is a transport-level fault that can occur
      // AFTER the request reached the server and the correction committed (e.g.
      // the connection dropped before the response arrived) — so the outcome is
      // genuinely ambiguous and re-confirming could double-write.
      console.warn("CorrectFactConfirmCard: confirm request failed before a response was read", {
        reason: err instanceof Error ? err.message : String(err),
      });
      const detail =
        err instanceof TypeError
          ? "could not reach the server"
          : err instanceof Error
            ? err.message
            : String(err);
      setCardState({
        phase: "error",
        retrySafe: false,
        message: `Network error — ${detail}. The correction may have been applied; ask Atlas to check the fact before trying again.`,
      });
    }
  }

  const isPending = cardState.phase === "idle" || cardState.phase === "submitting";
  const isSubmitting = cardState.phase === "submitting";

  const borderColor =
    cardState.phase === "applied"
      ? "border-green-300 dark:border-green-900/50"
      : cardState.phase === "error"
        ? "border-red-300 dark:border-red-900/50"
        : cardState.phase === "cancelled"
          ? "border-border"
          : isDestructive
            ? "border-amber-300 dark:border-amber-900/50"
            : "border-blue-300 dark:border-blue-900/50";

  const verbBadgeTone = isDestructive
    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
    : "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";

  return (
    <div className={`my-2 overflow-hidden rounded-lg border ${borderColor} bg-muted`}>
      {/* Header — the staged correction, always visible. */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span
          className={`rounded px-1.5 py-0.5 font-medium uppercase tracking-wide ${verbBadgeTone}`}
        >
          {confirmResult.verb}
        </span>
        <span className="flex-1 truncate text-foreground">
          {confirmResult.summary}
        </span>
      </div>

      {/* Pending: confirm-before-write controls. */}
      {isPending && (
        <div className="border-t border-border px-3 py-2">
          <p className="mb-2 text-xs text-muted-foreground">
            This will change your company brain on your authority, effective immediately. It has not
            been applied yet — confirm to proceed, or cancel to leave the fact as it is.
          </p>
          {confirmResult.confirm.reason ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Recorded reason: <span className="italic">{confirmResult.confirm.reason}</span>
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              onClick={handleConfirm}
              disabled={isSubmitting}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-[3px] ${
                isDestructive
                  ? "bg-amber-600 hover:bg-amber-500 focus-visible:ring-amber-500/50"
                  : "bg-blue-600 hover:bg-blue-500 focus-visible:ring-blue-500/50"
              }`}
            >
              {isSubmitting && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current" />
              )}
              Confirm correction
            </button>
            <button
              onClick={() => setCardState({ phase: "cancelled" })}
              disabled={isSubmitting}
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Resolved states. */}
      {cardState.phase === "applied" && (
        <div className="border-t border-border px-3 py-2">
          <div className="rounded bg-green-50 p-2 text-xs text-green-700 dark:bg-green-900/20 dark:text-green-400">
            <span className="font-medium">Correction applied</span>
            <p className="mt-1">{describeCorrectionOutcome(cardState.response)}</p>
          </div>
        </div>
      )}

      {cardState.phase === "cancelled" && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Cancelled — the fact was not changed.
        </div>
      )}

      {cardState.phase === "error" && (
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-red-600 dark:text-red-400">{cardState.message}</p>
          {/* Only re-arm Confirm when the correction provably didn't land (4xx).
              For an ambiguous outcome we deliberately offer no retry — the user
              asks Atlas to check the fact rather than risking a second write.
              Note the token is single-use, so a retry can itself be refused as a
              replay; the copy points at re-staging, which always works. */}
          {cardState.retrySafe && (
            <button
              onClick={() => setCardState({ phase: "idle" })}
              className="mt-2 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
