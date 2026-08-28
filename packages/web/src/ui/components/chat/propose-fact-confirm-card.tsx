"use client";

import { useState } from "react";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import {
  isProposeFactConfirmResult,
  describeProposalOutcome,
  getProposeFactError,
  type ProposeFactConfirmResult,
  type ProposeFactConfirmResponse,
} from "../../lib/propose-fact-types";
import { useAtlasConfig, useActionAuth } from "../../context";
import { LoadingCard } from "./loading-card";

/* ------------------------------------------------------------------ */
/*  Proposal confirm card (#5482, ADR-0036 §T7)                        */
/*                                                                     */
/*  Mirrors CorrectFactConfirmCard: the `proposeFact` tool STAGES a     */
/*  net-new claim (it never records one), returning a                  */
/*  `needs_confirmation` result. This card renders the banner; Confirm */
/*  POSTs the staged claim to /api/v1/brain-proposals/confirm, the ONLY*/
/*  place a chat-staged proposal enters the fact graph. Cancel         */
/*  dismisses — nothing is recorded.                                   */
/*                                                                     */
/*  ⚠️ This card SHOWS THE CLAIM, where the correction card            */
/*  deliberately does not show its target. Not an inconsistency: a     */
/*  correction's target text is ACL-gated storage, so previewing it    */
/*  means a second visibility decision; a proposal's text is the       */
/*  user's own words, and its exact wording IS what they are           */
/*  consenting to. Rendering it is what stops a confidently wrong      */
/*  agent sentence getting a differently worded claim confirmed.       */
/* ------------------------------------------------------------------ */

type CardState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "recorded"; response: ProposeFactConfirmResponse }
  | { phase: "cancelled" }
  /**
   * `retrySafe` gates the re-arming "Try again" button. It is `true` ONLY when
   * the proposal provably did NOT land — a 4xx, where the server rejected
   * before the write — so re-confirming cannot double-record.
   *
   * ⚠️ A retry re-POSTs the SAME token, and the token is single-use: the server
   * burns the nonce on the attempt, not on success. So a "Try again" after a
   * rejected confirm is refused as a replay, by design. The button only ever
   * helps for a transient rejection, and the honest path when it fails is to ask
   * Atlas to stage the proposal again. That is what the copy says.
   *
   * The stakes here are not only a duplicate draft. A proposal that AGREES with
   * an existing fact records evidence rather than a draft, and a second
   * attestation from one person is precisely the self-echo the distinct-source
   * corroboration count exists to discount — invisible in the UI, and wrong in
   * the direction that inflates confidence.
   */
  | { phase: "error"; message: string; retrySafe: boolean };

/** The compact line shown for any non-confirmation `proposeFact` result. */
/**
 * The half of the consent sentence that does not depend on where the proposal
 * came from — shared by the session and session-less arms so the two cannot
 * drift on what a confirmation means.
 */
const PROPOSAL_OUTCOME_TAIL =
  " If the brain already holds this claim, your confirmation is recorded as further evidence for " +
  "it instead. Nothing has been recorded yet.";

function ProposeFactErrorLine({ result }: { result: unknown }) {
  const message = getProposeFactError(result);
  return (
    <div className="my-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
      <span className="font-medium">Proposal not staged</span>
      {message ? <span className="ml-2">{message}</span> : null}
    </div>
  );
}

export function ProposeFactConfirmCard({ part }: { part: unknown }) {
  const { apiUrl } = useAtlasConfig();
  const actionAuth = useActionAuth();
  const done = isToolComplete(part);
  const result = getToolResult(part);

  const [cardState, setCardState] = useState<CardState>({ phase: "idle" });

  if (!done) return <LoadingCard label="Preparing proposal..." />;

  // Refusals / degraded paths render as a compact line, not a banner.
  if (!isProposeFactConfirmResult(result)) {
    return <ProposeFactErrorLine result={result} />;
  }

  const confirmResult: ProposeFactConfirmResult = result;
  const { subject, predicate, object } = confirmResult.confirm;

  async function handleConfirm() {
    if (!actionAuth) {
      console.warn(
        "ProposeFactConfirmCard: No AtlasProvider found. The confirm call will be sent without authentication.",
      );
    }
    setCardState({ phase: "submitting" });
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(actionAuth?.getHeaders() ?? {}),
      };
      const credentials = actionAuth?.getCredentials() ?? "same-origin";

      const res = await fetch(`${apiUrl}/api/v1/brain-proposals/confirm`, {
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
          console.debug("ProposeFactConfirmCard: error response body was not JSON", {
            reason: err instanceof Error ? err.message : String(err),
          });
          message = `${message}: ${text}`;
        }
        // Every 4xx here is raised BEFORE the write (no_workspace 400,
        // invalid/expired/replayed token 400, a claim that asserts nothing 400,
        // body validation 422) — so the proposal provably never landed. A 5xx is
        // raised at or after the transaction, so it may already have applied.
        const retrySafe = res.status < 500;
        if (!retrySafe) {
          message = `${message} — the claim may have been recorded. Ask Atlas to check before trying again.`;
        }
        setCardState({ phase: "error", message, retrySafe });
        return;
      }

      let data: ProposeFactConfirmResponse;
      try {
        data = (await res.json()) as ProposeFactConfirmResponse;
      } catch (err) {
        // A 2xx means the server committed — only the response body was
        // unreadable. It DID run; do not offer a re-arming retry.
        console.debug("ProposeFactConfirmCard: could not parse 2xx confirm response body", {
          reason: err instanceof Error ? err.message : String(err),
        });
        setCardState({
          phase: "error",
          retrySafe: false,
          message:
            "The claim was recorded, but its result could not be read. Ask Atlas to check the brain — do not re-run it.",
        });
        return;
      }
      setCardState({ phase: "recorded", response: data });
    } catch (err) {
      // fetch() rejected. A TypeError is a transport-level fault that can occur
      // AFTER the request reached the server and the write committed (e.g. the
      // connection dropped before the response arrived) — so the outcome is
      // genuinely ambiguous and re-confirming could double-record.
      console.warn("ProposeFactConfirmCard: confirm request failed before a response was read", {
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
        message: `Network error — ${detail}. The claim may have been recorded; ask Atlas to check before trying again.`,
      });
    }
  }

  const isPending = cardState.phase === "idle" || cardState.phase === "submitting";
  const isSubmitting = cardState.phase === "submitting";

  const borderColor =
    cardState.phase === "recorded"
      ? "border-green-300 dark:border-green-900/50"
      : cardState.phase === "error"
        ? "border-red-300 dark:border-red-900/50"
        : cardState.phase === "cancelled"
          ? "border-border"
          : "border-blue-300 dark:border-blue-900/50";

  return (
    <div className={`my-2 overflow-hidden rounded-lg border ${borderColor} bg-muted`}>
      {/* Header — the staged claim, always visible. */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium uppercase tracking-wide text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
          propose
        </span>
        <span className="flex-1 truncate text-foreground">{confirmResult.summary}</span>
      </div>

      {/* Pending: confirm-before-write controls. */}
      {isPending && (
        <div className="border-t border-border px-3 py-2">
          {/* The claim, spelled out slot by slot. The header's summary truncates;
              this is the part the human is actually consenting to, so it wraps
              rather than clipping. */}
          <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="break-words text-foreground">{subject}</dd>
            <dt className="text-muted-foreground">Predicate</dt>
            <dd className="break-words text-foreground">{predicate}</dd>
            <dt className="text-muted-foreground">Value</dt>
            <dd className="break-words text-foreground">{object}</dd>
          </dl>
          {/* The visibility sentence is part of what the human consents to, so
              it must state what actually lands (#5486): a proposal staged in a
              conversation takes the session's narrow grant seed — visible to
              you until a reviewer publishes it — where a session-less one
              takes the disclosed workspace grant. Deliberately NOT "the
              reviewer decides who sees it": the review gate's widening (issue
              5483) is the evidence-grant union at publish, not a per-fact
              audience picker, so this card must not promise a choice the
              reviewer does not have. */}
          <p className="mb-2 text-xs text-muted-foreground">
            {(confirmResult.confirm.session
              ? "This records a new claim in your company brain as a draft, with this conversation " +
                "recorded as its source. Until a reviewer publishes it, the draft is visible to you."
              : "This records a new claim in your company brain as a draft, visible to your workspace " +
                "and waiting for a reviewer to publish it.") + PROPOSAL_OUTCOME_TAIL}
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
              className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/50 disabled:opacity-40"
            >
              {isSubmitting && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current" />
              )}
              Confirm proposal
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
      {cardState.phase === "recorded" && (
        <div className="border-t border-border px-3 py-2">
          <div className="rounded bg-green-50 p-2 text-xs text-green-700 dark:bg-green-900/20 dark:text-green-400">
            <span className="font-medium">
              {cardState.response.outcome === "corroborated"
                ? "Recorded as evidence"
                : "Proposal recorded"}
            </span>
            <p className="mt-1">{describeProposalOutcome(cardState.response)}</p>
          </div>
        </div>
      )}

      {cardState.phase === "cancelled" && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Cancelled — nothing was recorded.
        </div>
      )}

      {cardState.phase === "error" && (
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-red-600 dark:text-red-400">{cardState.message}</p>
          {/* Only re-arm Confirm when the proposal provably didn't land (4xx).
              For an ambiguous outcome we deliberately offer no retry. Note the
              token is single-use, so a retry can itself be refused as a replay;
              the copy points at re-staging, which always works. */}
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
