/**
 * Map the `POST /api/auth/agent/approve-capability` response to the approval
 * page's terminal state (#4411).
 *
 * The plugin returns `{ status: "approved" | "denied" }` on success and a
 * `{ error, message }` envelope on a rejected decision (`invalid_user_code`,
 * `approval_expired`, `agent_not_found`, …). Discriminating on `kind` lets the
 * page reach `decision` only on success and `message` only on error.
 *
 * 404 is ambiguous on this endpoint and must NOT be blanket-mapped to
 * "unavailable": the #4409 request-time gate 404s the WHOLE surface with the
 * exact envelope `{ error: "not_found" }` when Agent Auth is off, but the plugin
 * ALSO 404s an individual stale/revoked agent with `{ error: "agent_not_found" }`
 * even when the feature is fully enabled. Only the gate envelope means the
 * surface is unavailable; a stale-agent 404 is a per-request error (the link is
 * no longer valid), so it flows to the error branch with the server's message.
 */

/** The exact error code the #4409 request-time gate returns (routes/auth.ts). */
const GATE_OFF_ERROR = "not_found";

export type ApprovalOutcome =
  | { kind: "resolved"; decision: "approved" | "denied" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** The parts of a `fetch` result this resolver needs. */
export interface ApprovalHttpResult {
  readonly status: number;
  /** Parsed JSON body (or `null` when the body wasn't JSON). */
  readonly body: unknown;
}

function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const code = (body as { error?: unknown }).error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.message === "string" && b.message) return b.message;
    if (typeof b.error === "string" && b.error) return b.error;
  }
  return fallback;
}

export function resolveApprovalOutcome(res: ApprovalHttpResult): ApprovalOutcome {
  if (res.status >= 200 && res.status < 300) {
    const status =
      res.body && typeof res.body === "object"
        ? (res.body as { status?: unknown }).status
        : undefined;
    if (status === "approved") return { kind: "resolved", decision: "approved" };
    if (status === "denied") return { kind: "resolved", decision: "denied" };
    return {
      kind: "error",
      message: "The approval completed with an unexpected response. Refresh and try again.",
    };
  }

  // Session lapsed between page load and the decision — give the same
  // actionable "sign in again" copy the pending-fetch path uses on a 401.
  if (res.status === 401) {
    return {
      kind: "error",
      message: "Your session expired. Sign in again to record your decision.",
    };
  }

  // ONLY the gate's whole-surface 404 means "unavailable". A stale/revoked
  // agent (`agent_not_found`) also 404s but is a per-request error.
  if (res.status === 404 && errorCode(res.body) === GATE_OFF_ERROR) {
    return { kind: "unavailable" };
  }

  return {
    kind: "error",
    message: messageFrom(
      res.body,
      "Could not record your decision. Refresh the page and try again.",
    ),
  };
}
