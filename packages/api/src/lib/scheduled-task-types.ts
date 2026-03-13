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
  connection_id: string | null;
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
