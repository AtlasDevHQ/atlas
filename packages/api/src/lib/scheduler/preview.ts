/**
 * Delivery preview — dry-run format templates with mock data.
 *
 * Generates sample output for each channel type using realistic mock
 * AgentQueryResult data so admins can preview what deliveries look like.
 */

import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";
import { formatEmailReport } from "./format-email";
import { formatSlackReport } from "./format-slack";
import { formatWebhookPayload } from "./format-webhook";

export interface DeliveryPreview {
  channel: string;
  /** For email: { subject, body (HTML) } */
  email?: { subject: string; body: string };
  /** For slack: { text, blocks } */
  slack?: { text: string; blocks: unknown[] };
  /** For webhook: the full JSON payload */
  webhook?: unknown;
  /** Fallback message when channel is unrecognized */
  fallbackMessage?: string;
}

const MOCK_RESULT: AgentQueryResult = {
  answer:
    "Yesterday's total revenue was $42,150.00 across 3 product lines. Enterprise licenses led with $28,500 (67.6%), followed by Professional at $10,200 (24.2%) and Starter at $3,450 (8.2%).",
  sql: [
    "SELECT product_line, SUM(amount) AS revenue, COUNT(*) AS transactions\nFROM orders\nWHERE created_at >= CURRENT_DATE - INTERVAL '1 day'\n  AND created_at < CURRENT_DATE\nGROUP BY product_line\nORDER BY revenue DESC",
  ],
  data: [
    {
      columns: ["product_line", "revenue", "transactions"],
      rows: [
        { product_line: "Enterprise", revenue: 28500, transactions: 12 },
        { product_line: "Professional", revenue: 10200, transactions: 34 },
        { product_line: "Starter", revenue: 3450, transactions: 87 },
      ],
    },
  ],
  steps: 3,
  usage: { totalTokens: 1847 },
};

export function generateDeliveryPreview(task: ScheduledTask): DeliveryPreview {
  const channel = task.deliveryChannel;
  const preview: DeliveryPreview = { channel };

  switch (channel) {
    case "email": {
      const { subject, body } = formatEmailReport(task, MOCK_RESULT);
      preview.email = { subject, body };
      break;
    }
    case "slack": {
      const { text, blocks } = formatSlackReport(task, MOCK_RESULT);
      preview.slack = { text, blocks };
      break;
    }
    case "webhook": {
      preview.webhook = formatWebhookPayload(task, MOCK_RESULT);
      break;
    }
    default: {
      const _exhaustive: never = channel;
      preview.fallbackMessage = `Unsupported delivery channel: ${_exhaustive}`;
    }
  }

  return preview;
}
