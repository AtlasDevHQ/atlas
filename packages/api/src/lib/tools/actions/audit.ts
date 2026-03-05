/**
 * Action lifecycle logger.
 *
 * Structured pino logs for every action state transition.
 *
 * State transitions:
 * - pending -> approved -> executed | failed
 * - pending -> denied
 * - pending -> auto_approved (executed inline) | failed
 * - pending -> timed_out (reserved, not yet implemented)
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ActionStatus } from "@atlas/api/lib/action-types";

const log = createLogger("action-audit");

export interface ActionAuditEntry {
  actionId: string;
  actionType: string;
  status: ActionStatus;
  latencyMs?: number;
  userId?: string;
  approverId?: string;
  error?: string;
}

export function logActionAudit(entry: ActionAuditEntry): void {
  const { actionId, actionType, status, latencyMs, userId, approverId, error } = entry;
  const fields = {
    actionId,
    actionType,
    status,
    ...(latencyMs !== undefined && { latencyMs }),
    ...(userId && { userId }),
    ...(approverId && { approverId }),
    ...(error && { error }),
  };

  if (status === "failed") {
    log.error(fields, `action_${status}`);
  } else if (status === "denied") {
    log.warn(fields, `action_${status}`);
  } else {
    log.info(fields, `action_${status}`);
  }
}
