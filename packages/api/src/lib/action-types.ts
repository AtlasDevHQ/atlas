/**
 * Action types for Atlas.
 *
 * ActionApprovalMode is re-exported from @useatlas/types/action.
 * ActionStatus tracks the server-internal lifecycle of an action request.
 * ActionRequest and ActionToolResult provide the tool-level interface.
 * AtlasAction extends the structural tool interface with action metadata.
 * ActionLogEntry represents the persisted audit row.
 */

export { ACTION_APPROVAL_MODES, ACTION_STATUSES } from "@useatlas/types/action";
export type { ActionApprovalMode, ActionStatus, ActionLogEntry, RollbackInfo } from "@useatlas/types/action";

import type { ActionApprovalMode } from "@useatlas/types/action";

/** Describes the action the agent wants to perform. */
export interface ActionRequest {
  id: string;
  actionType: string;
  target: string;
  summary: string;
  payload: Record<string, unknown>;
  reversible: boolean;
}

/** Discriminated union returned by action tools to the agent loop. */
export type ActionToolResult =
  | { status: "pending_approval"; actionId: string; summary: string }
  | { status: "executed"; actionId: string; result: unknown }
  | { status: "denied"; actionId: string; reason?: string }
  | { status: "auto_approved"; actionId: string; result: unknown }
  | { status: "failed"; actionId?: string; error: string }
  | { status: "timed_out"; actionId: string; error: string };

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

