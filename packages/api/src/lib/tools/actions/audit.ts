/**
 * Action lifecycle logger.
 *
 * Structured pino logs for every action state transition.
 *
 * State transitions:
 * - pending -> approved -> executed | failed | timed_out
 * - pending -> denied
 * - pending -> auto_approved (executed inline) | failed | timed_out
 * - executed | auto_approved -> rolled_back (via rollback API)
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ActionStatus } from "@atlas/api/lib/action-types";

const log = createLogger("action-audit");

export interface ActionAuditEntry {
  actionId: string;
  actionType: string;
  status: ActionStatus;
  latencyMs?: number;
  /** Configured timeout duration (logged when status is timed_out). */
  timeoutMs?: number;
  userId?: string;
  approverId?: string;
  error?: string;
}

export function logActionAudit(entry: ActionAuditEntry): void {
  const { actionId, actionType, status, latencyMs, timeoutMs, userId, approverId, error } = entry;
  const fields = {
    actionId,
    actionType,
    status,
    ...(latencyMs !== undefined && { latencyMs }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(userId && { userId }),
    ...(approverId && { approverId }),
    ...(error && { error }),
  };

  if (status === "failed" || status === "timed_out") {
    log.error(fields, `action_${status}`);
  } else if (status === "denied") {
    log.warn(fields, `action_${status}`);
  } else {
    log.info(fields, `action_${status}`);
  }
}
