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
  type HandleActionOptions,
  type ListActionsOptions,
} from "./handler";

export { logActionAudit, type ActionAuditEntry } from "./audit";

export { createJiraTicket } from "./jira";
export { sendEmailReport } from "./email";
