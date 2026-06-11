/**
 * Scheduled task types for Atlas.
 *
 * ScheduledTaskRow / ScheduledTaskRunRow are the DB shapes (API-internal only).
 * All other types (DeliveryChannel, RunStatus, ScheduledTask, etc.) are
 * re-exported from @useatlas/types/scheduled-task.
 */

// Re-export shared types from @useatlas/types
export {
  DELIVERY_CHANNELS,
  RUN_STATUSES,
  DELIVERY_STATUSES,
  isRecipient,
} from "@useatlas/types/scheduled-task";

import { DELIVERY_STATUSES } from "@useatlas/types/scheduled-task";

/**
 * Runtime accept-list for `scheduled_task_runs.delivery_status` (#3379).
 *
 * Extends the published `DELIVERY_STATUSES` with `"failed_permanent"` —
 * written by the executor when ALL delivery failures in a run were permanent
 * (misconfiguration: no email sender, no Slack token, blocked webhook URL),
 * so the run history can distinguish "fix your config" from "retry later".
 *
 * The new value lives HERE (scaffold-bound source) rather than in the
 * `DELIVERY_STATUSES` value export of `@useatlas/types`, because that package
 * is consumed from the npm registry by scaffold builds and a value change
 * would drift until the next publish + ref bump. The union type in
 * `@useatlas/types` carries `"failed_permanent"` type-only for the same
 * reason. Annotated `readonly string[]` (not `satisfies readonly
 * DeliveryStatus[]`) deliberately: scaffold builds type-check this file
 * against the *published* `.d.ts`, whose union may not yet include the new
 * member.
 */
export const KNOWN_DELIVERY_STATUSES: readonly string[] = [
  ...DELIVERY_STATUSES,
  "failed_permanent",
];
export type {
  DeliveryChannel,
  RunStatus,
  DeliveryStatus,
  EmailRecipient,
  SlackRecipient,
  WebhookRecipient,
  Recipient,
  ScheduledTask,
  ScheduledTaskWithRuns,
  ScheduledTaskRun,
  ScheduledTaskRunWithTaskName,
} from "@useatlas/types/scheduled-task";

// ---------------------------------------------------------------------------
// Database row shapes (snake_case) — API-internal only
// ---------------------------------------------------------------------------

export interface ScheduledTaskRow {
  id: string;
  owner_id: string;
  name: string;
  question: string;
  cron_expression: string;
  delivery_channel: string;
  recipients: unknown; // JSONB
  connection_group_id: string | null;
  approval_mode: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRunRow {
  id: string;
  task_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  conversation_id: string | null;
  action_id: string | null;
  error: string | null;
  tokens_used: number | null;
  delivery_status: string | null;
  delivery_error: string | null;
  created_at: string;
}
