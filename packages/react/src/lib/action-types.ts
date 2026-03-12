/** Status lifecycle for action tools that require user approval. */
export type ActionStatus =
  | "pending_approval"
  | "approved"
  | "executed"
  | "auto_approved"
  | "denied"
  | "failed"
  | "rolled_back"
  | "timed_out";

/** A status that is terminal (no longer pending). */
export type ResolvedStatus = Exclude<ActionStatus, "pending_approval">;

/** Single source of truth for every ActionStatus value. */
export const ALL_STATUSES = [
  "pending_approval",
  "approved",
  "executed",
  "auto_approved",
  "denied",
  "failed",
  "rolled_back",
  "timed_out",
] as const satisfies readonly ActionStatus[];

/** All statuses that are terminal (no longer pending). */
export const RESOLVED_STATUSES: ReadonlySet<ActionStatus> = new Set<ActionStatus>(
  ALL_STATUSES.filter((s): s is ResolvedStatus => s !== "pending_approval"),
);

/** Shape returned by action tools in the tool result. */
export interface ActionToolResultShape {
  status: ActionStatus;
  actionId: string;
  summary?: string;
  details?: Record<string, unknown>;
  result?: unknown;
  reason?: string;
  error?: string;
}

/** API response when approving or denying an action. */
export interface ActionApprovalResponse {
  actionId: string;
  status: ActionStatus;
  result?: unknown;
  error?: string;
}

/** All valid ActionStatus values (derived from ALL_STATUSES). */
const VALID_STATUSES: ReadonlySet<ActionStatus> = new Set<ActionStatus>(ALL_STATUSES);

/** Type guard: returns true if `result` looks like an action tool result. */
export function isActionToolResult(result: unknown): result is ActionToolResultShape {
  if (result == null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    typeof r.actionId === "string" &&
    typeof r.status === "string" &&
    VALID_STATUSES.has(r.status as ActionStatus)
  );
}
