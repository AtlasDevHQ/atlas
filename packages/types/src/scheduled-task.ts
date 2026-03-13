import type { ActionApprovalMode } from "./action";

// ---------------------------------------------------------------------------
// Enums (const arrays → union types)
// ---------------------------------------------------------------------------

export const DELIVERY_CHANNELS = ["email", "slack", "webhook"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const RUN_STATUSES = ["running", "success", "failed", "skipped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Recipient discriminated union
// ---------------------------------------------------------------------------

export interface EmailRecipient {
  type: "email";
  address: string;
}

export interface SlackRecipient {
  type: "slack";
  channel: string;
  teamId?: string;
}

export interface WebhookRecipient {
  type: "webhook";
  url: string;
  headers?: Record<string, string>;
}

export type Recipient = EmailRecipient | SlackRecipient | WebhookRecipient;

// ---------------------------------------------------------------------------
// API shapes (camelCase)
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  ownerId: string;
  name: string;
  question: string;
  cronExpression: string;
  deliveryChannel: DeliveryChannel;
  /** Recipients should match the deliveryChannel type (email recipients for email channel, etc). */
  recipients: Recipient[];
  connectionId: string | null;
  approvalMode: ActionApprovalMode;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskWithRuns extends ScheduledTask {
  recentRuns: ScheduledTaskRun[];
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt: string | null;
  status: RunStatus;
  conversationId: string | null;
  actionId: string | null;
  error: string | null;
  tokensUsed: number | null;
  deliveryStatus: DeliveryStatus | null;
  deliveryError: string | null;
  createdAt: string;
}

/** Cross-task run with the parent task name joined for display. */
export interface ScheduledTaskRunWithTaskName extends ScheduledTaskRun {
  taskName: string;
}

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

/** Runtime type guard for Recipient — validates JSONB boundary. */
export function isRecipient(value: unknown): value is Recipient {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const r = value as Record<string, unknown>;
  switch (r.type) {
    case "email": return typeof r.address === "string" && r.address.length > 0;
    case "slack": return typeof r.channel === "string" && r.channel.length > 0;
    case "webhook": return typeof r.url === "string" && r.url.length > 0;
    default: return false;
  }
}
