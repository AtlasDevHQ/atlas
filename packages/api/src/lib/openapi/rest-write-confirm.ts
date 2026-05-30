/**
 * Shared contract for the REST confirm-before-write flow (PRD #2868 slice 5,
 * #2929). When the agent stages an allowlisted write, `executeRestOperation`
 * returns a `needs_confirmation` result carrying a {@link RestWriteConfirmRequest}
 * — the exact replay payload the chat surface's confirm-before-write banner POSTs
 * to `POST /api/v1/rest-operations/confirm`. The write fires there, after the
 * human confirms, never silently in the agent loop.
 *
 * This module is the single source of truth for that wire shape + the
 * human-facing summary, so the staging tool and the confirming endpoint can't
 * drift. Both re-run {@link import("./validate-rest-operation").validateRestOperation}
 * against the resolved datasource — the confirm endpoint is NOT a trusted
 * fast-path; it re-validates the allowlist + params server-side (defense in
 * depth: a tampered client payload still can't escalate past the allowlist).
 */
import type { Operation, OperationParams } from "./types";

/** A scalar param value the agent / banner may carry (matches the tool input). */
export type RestParamScalar = string | number | boolean;

/**
 * The replay payload for a staged write. Bucketed exactly like the
 * `executeRestOperation` tool input so the banner echoes back what the agent
 * staged; the confirm endpoint converts it into {@link OperationParams}.
 */
export interface RestWriteConfirmRequest {
  readonly datasourceId: string;
  readonly operationId: string;
  readonly pathParams?: Record<string, RestParamScalar>;
  readonly query?: Record<string, RestParamScalar | ReadonlyArray<RestParamScalar>>;
  readonly header?: Record<string, RestParamScalar>;
  /** JSON request body for the write. */
  readonly body?: unknown;
}

/** Convert a {@link RestWriteConfirmRequest} into the client's {@link OperationParams}. */
export function confirmRequestToParams(req: RestWriteConfirmRequest): OperationParams {
  return {
    ...(req.pathParams ? { path: req.pathParams } : {}),
    ...(req.query ? { query: req.query } : {}),
    ...(req.header ? { header: req.header } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  };
}

/**
 * A concise, factual one-line description of a staged write for the banner
 * header, e.g. `Delete a person — DELETE /people/{id} on Twenty` — the label is
 * the operation's spec `summary` when present, falling back to its
 * `operationId`. The agent supplies the richer natural-language framing
 * ("permanently delete 3 people") in its turn; this derives purely from the
 * resolved {@link Operation} (it takes no agent-supplied params) so the banner
 * can't misstate the verb or target even if the agent's prose is wrong.
 */
export function buildRestWriteSummary(operation: Operation, datasourceName: string): string {
  const label = operation.summary?.trim() || operation.operationId;
  return `${label} — ${operation.method} ${operation.path} on ${datasourceName}`;
}
