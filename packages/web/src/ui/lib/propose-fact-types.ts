/**
 * Web-local mirror of the `proposeFact` tool result shape (#5482) — only the
 * fields the chat surface renders.
 *
 * A deliberate local mirror, not a `@useatlas/types` import, for the reason
 * `correct-fact-types.ts` and `rest-operation-types.ts` both state: the wire
 * shape is produced by `packages/api/src/lib/brain/proposal-confirm.ts`, but
 * pulling a new VALUE export through `@useatlas/types` needs the
 * publish-then-bump dance, and a new value export trips Scaffold CI before it is
 * published. The shapes must stay in sync; promote the mirrors together when a
 * types release is cut for another reason.
 */

/** The replay payload the confirm card POSTs to the confirm endpoint. */
export interface ProposeFactConfirmRequest {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  reason?: string;
  /**
   * The session the proposal was staged in (#5486). Opaque to the card beyond
   * one read: its PRESENCE switches the visibility sentence, because a
   * session-carrying proposal lands with the session's narrow grant seed (the
   * proposer, until a reviewer widens it) where a session-less one lands
   * workspace-visible. POSTed back verbatim — the confirm token binds it.
   */
  session?: { conversationId: string };
  /**
   * Server-signed, single-use confirm token. Opaque to the card — it POSTs the
   * whole `confirm` payload (including this token) verbatim; the confirm
   * endpoint re-derives the binding, verifies it, then burns it so a replay is
   * rejected. Always present on a `needs_confirmation` result from the API.
   */
  token: string;
}

/** The `needs_confirmation` arm — a claim staged for human confirmation. */
export interface ProposeFactConfirmResult {
  status: "needs_confirmation";
  summary: string;
  confirm: ProposeFactConfirmRequest;
}

/**
 * Narrow an unknown tool result to the `needs_confirmation` arm.
 *
 * The three claim surfaces are checked on `confirm`, not merely `confirm`'s
 * presence, because the card RENDERS them: a result that satisfied a shallower
 * guard would reach the confirm button with `undefined` where the asserted value
 * should be, and the human would be consenting to a claim the card could not
 * show them. That is the one failure this card exists to prevent, so the guard
 * checks exactly what it displays.
 */
export function isProposeFactConfirmResult(
  result: unknown,
): result is ProposeFactConfirmResult {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.status !== "needs_confirmation" || typeof r.summary !== "string") return false;
  if (r.confirm == null || typeof r.confirm !== "object") return false;
  const confirm = r.confirm as Record<string, unknown>;
  return (
    typeof confirm.subject === "string" &&
    confirm.subject !== "" &&
    typeof confirm.predicate === "string" &&
    confirm.predicate !== "" &&
    typeof confirm.object === "string" &&
    confirm.object !== "" &&
    typeof confirm.token === "string"
  );
}

/**
 * The confirm endpoint's success response
 * (`POST /api/v1/brain-proposals/confirm`).
 *
 * Two arms, and the card must not collapse them. `proposed` means a draft now
 * waits for a reviewer; `corroborated` means the workspace already believed this
 * and the claim was recorded as further evidence — no draft, no review queue,
 * nothing for anyone to approve. Telling a user their fact is "queued for
 * review" when nothing was queued is exactly the confident wrongness the confirm
 * flow exists to remove.
 */
export type ProposeFactConfirmResponse =
  | {
      outcome: "proposed";
      factId: string;
      status: "draft";
      proposalEpisodeId: string;
      provisional: boolean;
      tensionEdges: number;
    }
  | {
      outcome: "corroborated";
      factId: string;
      proposalEpisodeId: string;
      evidenceAdded: boolean;
    };

/** Best-effort human message off any error-shaped `proposeFact` result arm. */
export function getProposeFactError(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const error = (result as Record<string, unknown>).error;
  return typeof error === "string" ? error : undefined;
}

/** One plain sentence describing what a confirmed proposal did. */
export function describeProposalOutcome(response: ProposeFactConfirmResponse): string {
  if (response.outcome === "corroborated") {
    return response.evidenceAdded
      ? "Your company brain already held this claim, so it was recorded as further evidence for the existing fact rather than as a new draft. It counts toward how well corroborated that fact is."
      : "Your company brain already held this claim, and this exact evidence was already recorded — nothing changed.";
  }
  const tension =
    response.tensionEdges > 0
      ? ` It was flagged as possibly in tension with ${response.tensionEdges} existing claim(s) for the reviewer to look at.`
      : "";
  return `Recorded as a draft. It is not an answer yet — a reviewer publishes it before Atlas will use it.${tension}`;
}
