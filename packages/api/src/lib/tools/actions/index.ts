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
  registerActionExecutor,
  getActionExecutor,
  _resetActionStore,
  type ActionExecutionContext,
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
