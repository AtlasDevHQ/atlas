/**
 * Unit tests for the delivery preview generator.
 */
import { describe, it, expect } from "bun:test";
import { generateDeliveryPreview } from "../preview";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-task-types";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    ownerId: "u1",
    name: "Daily Revenue",
    question: "What was yesterday's revenue?",
    cronExpression: "0 9 * * 1",
    deliveryChannel: "email",
    recipients: [],
    connectionId: null,
    approvalMode: "auto",
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2024-01-01T09:00:00Z",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("generateDeliveryPreview", () => {
  it("generates email preview with subject and body", () => {
    const task = makeTask({ deliveryChannel: "email" });
    const preview = generateDeliveryPreview(task);

    expect(preview.channel).toBe("email");
    expect(preview.email).toBeDefined();
    expect(preview.email!.subject).toBeString();
    expect(preview.email!.subject.length).toBeGreaterThan(0);
    expect(preview.email!.body).toBeString();
    expect(preview.email!.body.length).toBeGreaterThan(0);
    expect(preview.slack).toBeUndefined();
    expect(preview.webhook).toBeUndefined();
  });

  it("generates slack preview with text and blocks", () => {
    const task = makeTask({ deliveryChannel: "slack" });
    const preview = generateDeliveryPreview(task);

    expect(preview.channel).toBe("slack");
    expect(preview.slack).toBeDefined();
    expect(preview.slack!.text).toBeString();
    expect(Array.isArray(preview.slack!.blocks)).toBe(true);
    expect(preview.email).toBeUndefined();
    expect(preview.webhook).toBeUndefined();
  });

  it("generates webhook preview with payload", () => {
    const task = makeTask({ deliveryChannel: "webhook" });
    const preview = generateDeliveryPreview(task);

    expect(preview.channel).toBe("webhook");
    expect(preview.webhook).toBeDefined();
    expect(preview.email).toBeUndefined();
    expect(preview.slack).toBeUndefined();
  });

  it("includes task name in email subject", () => {
    const task = makeTask({ deliveryChannel: "email", name: "My Custom Task" });
    const preview = generateDeliveryPreview(task);

    expect(preview.email!.subject).toContain("My Custom Task");
  });

  it("webhook payload includes task metadata", () => {
    const task = makeTask({ deliveryChannel: "webhook", name: "Revenue Check" });
    const preview = generateDeliveryPreview(task);
    const payload = preview.webhook as Record<string, unknown>;

    expect(payload).toBeDefined();
    expect(payload.taskName).toBe("Revenue Check");
  });
});
