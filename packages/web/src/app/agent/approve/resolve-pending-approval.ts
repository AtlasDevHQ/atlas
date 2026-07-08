/**
 * Map the Agent Auth pending-approvals payload to the one request the approval
 * page should render (#4411).
 *
 * The device-authorization approval page is opened at
 * `/agent/approve?agent_id=<id>&code=<user_code>` (the plugin's
 * `verification_uri_complete`). To render the pending capability request we read
 * the signed-in user's pending approvals from `GET /api/auth/agent/ciba/pending`
 * — despite the CIBA-flavoured path, the plugin returns BOTH `ciba` and
 * `device_authorization` pending requests there — and pick the one that belongs
 * to this `agent_id`.
 *
 * `user_code` is deliberately NOT in the listing (only its hash is stored
 * server-side), so we match on `agent_id` + `method === "device_authorization"`.
 * The code still round-trips to the server on approve, where it is verified
 * against the stored hash — this resolver only chooses what to display.
 *
 * Defensive parse: an unexpected shape degrades to `not-found` rather than
 * throwing, so a plugin-version response drift shows the recoverable "no pending
 * request" screen instead of a crash.
 */

/** One pending capability request, as rendered by the approval page. */
export interface PendingApprovalRequest {
  readonly approvalId: string;
  readonly agentId: string;
  readonly agentName: string | null;
  readonly bindingMessage: string | null;
  readonly capabilities: readonly string[];
  readonly capabilityReasons: Readonly<Record<string, string>>;
  readonly expiresIn: number;
}

export type PendingApprovalLookup =
  | { kind: "ready"; request: PendingApprovalRequest }
  | { kind: "not-found" };

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asReasonMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Find the device-authorization request for `agentId` in the pending payload.
 * Returns `ready` with a normalized request, or `not-found` (no match, wrong
 * method, or malformed payload).
 */
export function resolvePendingApproval(
  payload: unknown,
  agentId: string,
): PendingApprovalLookup {
  if (!agentId) return { kind: "not-found" };
  const requests =
    payload && typeof payload === "object" && Array.isArray((payload as { requests?: unknown }).requests)
      ? ((payload as { requests: unknown[] }).requests)
      : [];

  for (const raw of requests) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.method !== "device_authorization") continue;
    if (asString(r.agent_id) !== agentId) continue;
    const approvalId = asString(r.approval_id);
    if (!approvalId) continue;
    return {
      kind: "ready",
      request: {
        approvalId,
        agentId,
        agentName: asString(r.agent_name),
        bindingMessage: asString(r.binding_message),
        capabilities: asStringArray(r.capabilities),
        capabilityReasons: asReasonMap(r.capability_reasons),
        expiresIn: typeof r.expires_in === "number" ? r.expires_in : 0,
      },
    };
  }
  // A non-empty list with no match on our fields is the signature of a plugin
  // response-shape drift (a renamed `agent_id`/`approval_id`/`method`), which
  // would otherwise present identically to a legitimately-empty list ("no
  // pending request"). Leave a breadcrumb so a drift outage is traceable
  // without changing the recoverable UX.
  if (requests.length > 0) {
    console.debug(
      `resolvePendingApproval: ${requests.length} pending request(s) but none matched agent ${agentId} — check for @better-auth/agent-auth response drift`,
    );
  }
  return { kind: "not-found" };
}
