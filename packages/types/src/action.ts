// ---------------------------------------------------------------------------
// Action approval modes (shared across API, frontend, SDK)
// ---------------------------------------------------------------------------

export const ACTION_APPROVAL_MODES = ["auto", "manual", "admin-only"] as const;
export type ActionApprovalMode = (typeof ACTION_APPROVAL_MODES)[number];

// ---------------------------------------------------------------------------
// Client-facing action display status lifecycle (frontend wire format)
// ---------------------------------------------------------------------------

/**
 * Display status lifecycle for action tools that require user approval.
 *
 * Distinct from the server-internal `ActionStatus` in `@atlas/api` which
 * uses "pending" instead of "pending_approval" and omits "rolled_back".
 */
export type ActionDisplayStatus =
  | "pending_approval"
  | "approved"
  | "executed"
  | "auto_approved"
  | "denied"
  | "failed"
  | "rolled_back"
  | "timed_out";

/** A display status that is terminal (no longer pending). */
export type ResolvedDisplayStatus = Exclude<ActionDisplayStatus, "pending_approval">;

/** Single source of truth for every ActionDisplayStatus value. */
export const ALL_STATUSES = [
  "pending_approval",
  "approved",
  "executed",
  "auto_approved",
  "denied",
  "failed",
  "rolled_back",
  "timed_out",
] as const satisfies readonly ActionDisplayStatus[];

/** All statuses that are terminal (no longer pending). */
export const RESOLVED_STATUSES: ReadonlySet<ActionDisplayStatus> = new Set<ActionDisplayStatus>(
  ALL_STATUSES.filter((s): s is ResolvedDisplayStatus => s !== "pending_approval"),
);

/** Discriminated union returned by action tools in the tool result. */
export type ActionToolResultShape =
  | { status: "pending_approval"; actionId: string; summary: string; details?: Record<string, unknown> }
  | { status: "approved" | "executed" | "auto_approved"; actionId: string; result: unknown; summary?: string; details?: Record<string, unknown> }
  | { status: "denied"; actionId: string; reason: string; summary?: string; details?: Record<string, unknown> }
  | { status: "failed"; actionId: string; error: string; summary?: string; details?: Record<string, unknown> }
  | { status: "rolled_back" | "timed_out"; actionId: string; summary?: string; details?: Record<string, unknown> };

/** API response when approving or denying an action. */
export interface ActionApprovalResponse {
  actionId: string;
  status: ActionDisplayStatus;
  result?: unknown;
  error?: string;
}

/** All valid ActionDisplayStatus values (derived from ALL_STATUSES). */
const VALID_STATUSES: ReadonlySet<ActionDisplayStatus> = new Set<ActionDisplayStatus>(ALL_STATUSES);

/** Type guard: returns true if `result` looks like an action tool result. */
export function isActionToolResult(result: unknown): result is ActionToolResultShape {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    typeof r.actionId === "string" &&
    typeof r.status === "string" &&
    VALID_STATUSES.has(r.status as ActionDisplayStatus)
  );
}
