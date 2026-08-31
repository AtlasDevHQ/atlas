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
  | { status: "pending"; actionId: string; summary: string }
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
  /**
   * How this action type executes, for a PLUGIN-declared action (#5570).
   *
   * The five built-in action modules do not use this field: they call
   * `defineActionExecutor` themselves at module load, beside their
   * `AtlasAction`. A plugin cannot — it is loaded dynamically and must not
   * import `@atlas/api` — so it declares the executor here and
   * `wireActionPlugins` registers it into the same type-keyed registry. One
   * seam for both paths, which is what keeps a plugin action from being the
   * one kind that still strands after a restart.
   *
   * Structurally typed rather than importing `ActionExecutor`, for the reason
   * `tool: unknown` is: this module cannot depend on the handler, and the
   * plugin SDK mirrors the same shape without depending on either.
   *
   * ⚠️ Must be a pure function of `(payload, ctx)`. Everything it needs comes
   * from the persisted row, because that is all a re-dispatching instance has.
   * `ctx.workspaceId` is the ACTION's workspace (ADR-0046) — resolve
   * credentials from it, never from ambient request state.
   */
  readonly executor?: (
    payload: Record<string, unknown>,
    ctx: { readonly workspaceId: string | null },
  ) => Promise<unknown>;
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

