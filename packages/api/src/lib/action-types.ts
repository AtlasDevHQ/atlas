/**
 * Action types for Atlas.
 *
 * ActionApprovalMode determines how an action request is handled.
 * ActionStatus tracks the lifecycle of an action request.
 * ActionRequest and ActionToolResult provide the tool-level interface.
 * AtlasAction extends the structural tool interface with action metadata.
 * ActionLogEntry represents the persisted audit row.
 */

export const ACTION_APPROVAL_MODES = ["auto", "manual", "admin-only"] as const;
export type ActionApprovalMode = (typeof ACTION_APPROVAL_MODES)[number];

export const ACTION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "executed",
  "failed",
  "timed_out", // Reserved — not yet implemented
  "auto_approved",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Describes the action the agent wants to perform. */
export interface ActionRequest {
  id: string;
  actionType: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  reversible: boolean;
}

/** Information needed to undo an executed action. */
export interface RollbackInfo {
  method: string;
  params: Record<string, unknown>;
}

/** Discriminated union returned by action tools to the agent loop. */
export type ActionToolResult =
  | { status: "pending_approval"; actionId: string; summary: string }
  | { status: "executed"; actionId: string; result: unknown }
  | { status: "denied"; actionId: string; reason?: string }
  | { status: "auto_approved"; actionId: string; result: unknown }
  | { status: "error"; actionId?: string; error: string };

/**
 * Structural superset of AtlasTool with action-specific metadata.
 *
 * Uses `tool: unknown` because action-types cannot import `ToolSet`
 * from the `ai` package. Structural typing ensures compatibility when
 * registered in ToolRegistry.
 */
export interface AtlasAction {
  readonly name: string;
  readonly description: string;
  readonly tool: unknown;
  readonly actionType: string;
  readonly reversible: boolean;
  readonly defaultApproval: ActionApprovalMode;
  readonly requiredCredentials: string[];
}

/** Type guard: returns true if the tool has action metadata. */
export function isAction(tool: { readonly name: string }): tool is AtlasAction {
  return (
    "actionType" in tool &&
    "reversible" in tool &&
    "defaultApproval" in tool &&
    "requiredCredentials" in tool
  );
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
