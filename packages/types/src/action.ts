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
 * uses "pending" instead of "pending_approval".
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
  | { status: "denied"; actionId: string; reason?: string; summary?: string; details?: Record<string, unknown> }
  | { status: "failed"; actionId: string; error: string; summary?: string; details?: Record<string, unknown> }
  | { status: "rolled_back" | "timed_out"; actionId: string; summary?: string; details?: Record<string, unknown> };

/** API response when approving or denying an action. */
export interface ActionApprovalResponse {
  actionId: string;
  status: ActionDisplayStatus;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Server-side action status lifecycle (persisted in action_log table)
// ---------------------------------------------------------------------------

export const ACTION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "executed",
  "failed",
  "timed_out",
  "auto_approved",
  "rolled_back",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Information needed to undo an executed action. */
export interface RollbackInfo {
  method: string;
  params: Record<string, unknown>;
}

/** Database row shape for the action_log table. */
export interface ActionLogEntry {
  id: string;
  requested_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  requested_by: string | null;
  approved_by: string | null;
  auth_mode: string;
  action_type: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  status: ActionStatus;
  result: unknown;
  error: string | null;
  rollback_info: RollbackInfo | null;
  conversation_id: string | null;
  request_id: string | null;
}

/** All valid ActionDisplayStatus values (derived from ALL_STATUSES). */
const VALID_STATUSES: ReadonlySet<ActionDisplayStatus> = new Set<ActionDisplayStatus>(ALL_STATUSES);

/** Type guard: returns true if `result` looks like an action tool result. */
export function isActionToolResult(result: unknown): result is ActionToolResultShape {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (typeof r.actionId !== "string" || r.actionId.length === 0) return false;
  if (typeof r.status !== "string") return false;
  if (!VALID_STATUSES.has(r.status as ActionDisplayStatus)) return false;

  switch (r.status) {
    case "pending_approval":
      return typeof r.summary === "string";
    case "approved":
    case "executed":
    case "auto_approved":
      return "result" in r;
    case "failed":
      return typeof r.error === "string";
    case "denied":
    case "rolled_back":
    case "timed_out":
      return true;
    default:
      // Unreachable: VALID_STATUSES.has() above guarantees status is in ActionDisplayStatus.
      // If you add a new status, add a case here too.
      return false;
  }
}
