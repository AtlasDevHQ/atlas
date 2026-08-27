/**
 * Web-local mirror of the `correct_fact` tool result shape (#5496) — only the
 * fields the chat surface renders.
 *
 * A deliberate local mirror, not a `@useatlas/types` import, for the reason
 * `rest-operation-types.ts` states one file over: the wire shape is produced by
 * `packages/api/src/lib/brain/correction-confirm.ts`, but pulling a new VALUE
 * export through `@useatlas/types` needs the publish-then-bump dance, and a new
 * value export trips Scaffold CI before it is published. The two shapes must
 * stay in sync; promote both mirrors together when a types release is cut for
 * another reason.
 */

/** The correction verbs, mirroring `CORRECTION_VERBS` in `lib/brain/correction.ts`. */
export type BrainCorrectionVerb = "retract" | "supersede" | "re-authority" | "pin";

/** The replay payload the confirm card POSTs to the confirm endpoint. */
export interface CorrectFactConfirmRequest {
  factId: string;
  verb: BrainCorrectionVerb;
  reason?: string;
  replacement?: { object: string; validFrom?: string };
  /**
   * Server-signed, single-use confirm token. Opaque to the card — it POSTs the
   * whole `confirm` payload (including this token) verbatim; the confirm
   * endpoint re-derives the binding, verifies it, then burns it so a replay is
   * rejected. Always present on a `needs_confirmation` result from the API.
   */
  token: string;
}

/** The `needs_confirmation` arm — a correction staged for human confirmation. */
export interface CorrectFactConfirmResult {
  status: "needs_confirmation";
  factId: string;
  verb: BrainCorrectionVerb;
  summary: string;
  confirm: CorrectFactConfirmRequest;
}

/** Narrow an unknown tool result to the `needs_confirmation` arm. */
export function isCorrectFactConfirmResult(result: unknown): result is CorrectFactConfirmResult {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    r.status === "needs_confirmation" &&
    typeof r.factId === "string" &&
    typeof r.verb === "string" &&
    typeof r.summary === "string" &&
    typeof r.confirm === "object" &&
    r.confirm !== null
  );
}

/**
 * The confirm endpoint's success response
 * (`POST /api/v1/brain-corrections/confirm`).
 *
 * `flaggedForReReviewCount` is a COUNT and never the ids — the server projects
 * it that way deliberately (the dependent-facts query is un-ACL-gated, so a
 * subset of those ids names facts this user cannot read). Render the number;
 * there is nothing else to render, and no queue lists them.
 */
export interface CorrectFactConfirmResponse {
  status: "corrected";
  verb: BrainCorrectionVerb;
  factId: string;
  correctionEpisodeId: string;
  invalidatedAt: string | null;
  supersededBy: string | null;
  validTo: string | null;
  flaggedForReReviewCount: number;
}

/** Best-effort human message off any error-shaped `correct_fact` result arm. */
export function getCorrectFactError(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const error = (result as Record<string, unknown>).error;
  return typeof error === "string" ? error : undefined;
}

/**
 * One plain sentence describing what a confirmed correction did, for the
 * resolved state of the card.
 *
 * Mirrors `summarize()` in the API's old tool result: for `retract` the flagged
 * count IS the whole report — no queue lists those facts — so the copy says so
 * rather than implying somewhere to go work through them.
 */
export function describeCorrectionOutcome(response: CorrectFactConfirmResponse): string {
  switch (response.verb) {
    case "retract":
      return response.flaggedForReReviewCount > 0
        ? `Retracted. ${response.flaggedForReReviewCount} derived fact(s) were marked as needing human re-review — nothing was removed automatically, and this count is the whole report: no queue lists them.`
        : "Retracted. It leaves current answers immediately but stays readable as history.";
    case "supersede":
      return "The corrected value is now the current belief; the old one stays readable as history with a recorded end date.";
    case "re-authority":
      return "The claim's authority was re-anchored on you — it now carries your confirmation as its freshest evidence.";
    case "pin":
      return "Pinned: your confirmation is recorded as fresh evidence, resetting its staleness clock.";
    default:
      return "The correction was applied.";
  }
}

// ---------------------------------------------------------------------------
// The surface header (#5496)
// ---------------------------------------------------------------------------

/**
 * The header this app sends on every `/api/v1/chat` request to identify itself
 * as the workspace web app.
 *
 * `POST /api/v1/chat` serves this app AND the embeddable widget
 * (`@useatlas/react`) over one URL, with the same auth and the same body.
 * Nothing else separates them, and only this app renders the correction confirm
 * card above — so the server offers `correct_fact` only to a caller that sends
 * this. Absence is fail-closed.
 *
 * Mirrored, not imported, for the reason stated at the top of this file and in
 * `rest-operation-types.ts`: a new VALUE export in `@useatlas/types` does not
 * exist in the published package until a release is cut, and the scaffold smoke
 * test builds against npm — so it fails Scaffold CI at build time. The server
 * half is `packages/api/src/lib/chat-surface.ts`; these two literals must stay
 * identical.
 *
 * ⚠️ A capability hint, never a credential. It gets a correction STAGED and
 * nothing more; the write is gated server-side at
 * `POST /api/v1/brain-corrections/confirm`.
 */
export const ATLAS_SURFACE_HEADER = "x-atlas-surface";

/** This app's surface identity. Must equal the server's `ATLAS_WORKSPACE_SURFACE`. */
export const ATLAS_WORKSPACE_SURFACE = "workspace";
