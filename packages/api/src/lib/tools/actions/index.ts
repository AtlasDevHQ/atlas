/**
 * Action framework — barrel exports.
 */

export {
  handleAction,
  approveAction,
  denyAction,
  getAction,
  listPendingActions,
  buildActionRequest,
  getActionConfig,
  // The action_type-keyed executor registry (#5570). `defineActionExecutor` is
  // called at MODULE LOAD beside each `AtlasAction`, and by `wireActionPlugins`
  // for plugin-declared types — never per request.
  defineActionExecutor,
  getActionExecutorForType,
  isActionTypeExecutable,
  redispatchActionAsUser,
  _resetActionStore,
  type ActionExecutor,
  type ActionExecutionContext,
  type RedispatchActionOutcome,
  type HandleActionOptions,
  type ListActionsOptions,
} from "./handler";

export { logActionAudit, type ActionAuditEntry } from "./audit";

export { createJiraTicket } from "./jira";
export { createLinearTicket } from "./linear";
export { createGitHubIssue } from "./github";
export { sendEmailReport } from "./email";
export {
  createSalesforceRecord,
  SALESFORCE_ACTION_OBJECTS,
  type SalesforceActionObject,
} from "./salesforce";
export { ACTION_TOOL_NAMES, type ActionToolName } from "./manifest";

import type { AtlasAction } from "@atlas/api/lib/action-types";
import { createJiraTicket } from "./jira";
import { createLinearTicket } from "./linear";
import { createGitHubIssue } from "./github";
import { sendEmailReport } from "./email";
import { createSalesforceRecord } from "./salesforce";

/**
 * Every operator action tool, in registration order. `buildRegistry` iterates
 * this instead of destructuring five names, so adding target #6 is this list
 * plus one name in `./manifest` — `registry-actions.test.ts` pins the two
 * lists to each other, which is what keeps the failure-warning copy (built
 * from the manifest, readable even when THIS module fails to load) true to
 * what actually registers.
 */
export const ACTION_TOOLS: readonly AtlasAction[] = [
  createJiraTicket,
  createGitHubIssue,
  createLinearTicket,
  sendEmailReport,
  createSalesforceRecord,
];

// Per-workspace action-target credentials (#3766). The resolver is the single
// place the workspace → self-host-env ladder is decided; the target registry
// is the one-entry seam a new action target extends.
export {
  resolveActionCredentials,
  getActionTargetStatus,
  ActionCredentialError,
  type ResolvedActionCredentials,
  type ActionCredentialSource,
  type ActionTargetStatus,
} from "./credentials/resolver";
export {
  ACTION_TARGETS,
  getActionTarget,
  type ActionTargetSpec,
  type ActionCredentialField,
} from "./credentials/targets";
