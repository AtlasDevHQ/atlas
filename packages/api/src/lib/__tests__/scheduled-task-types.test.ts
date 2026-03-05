/**
 * Unit tests for scheduled task type definitions.
 */
import { describe, it, expect } from "bun:test";
import {
  DELIVERY_CHANNELS,
  RUN_STATUSES,
  type EmailRecipient,
  type SlackRecipient,
  type WebhookRecipient,
  type Recipient,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "../scheduled-task-types";

describe("scheduled-task-types", () => {
  describe("DELIVERY_CHANNELS", () => {
    it("contains email, slack, webhook", () => {
      expect(DELIVERY_CHANNELS).toEqual(["email", "slack", "webhook"]);
    });

    it("is a readonly tuple (as const)", () => {
      // TypeScript enforces readonly at compile time; at runtime the array is mutable.
      // Verify it has exactly 3 entries as defined.
      expect(DELIVERY_CHANNELS.length).toBe(3);
    });
  });

  describe("RUN_STATUSES", () => {
    it("contains running, success, failed, skipped", () => {
      expect(RUN_STATUSES).toEqual(["running", "success", "failed", "skipped"]);
    });

    it("is a readonly tuple (as const)", () => {
      expect(RUN_STATUSES.length).toBe(4);
    });
  });

  describe("Recipient types", () => {
    it("EmailRecipient has type email and address", () => {
      const r: EmailRecipient = { type: "email", address: "test@example.com" };
      expect(r.type).toBe("email");
      expect(r.address).toBe("test@example.com");
    });

    it("SlackRecipient has type slack, channel, and optional teamId", () => {
      const r: SlackRecipient = { type: "slack", channel: "#general" };
      expect(r.type).toBe("slack");
      expect(r.channel).toBe("#general");
      expect(r.teamId).toBeUndefined();

      const r2: SlackRecipient = { type: "slack", channel: "#general", teamId: "T123" };
      expect(r2.teamId).toBe("T123");
    });

    it("WebhookRecipient has type webhook, url, and optional headers", () => {
      const r: WebhookRecipient = { type: "webhook", url: "https://example.com/hook" };
      expect(r.type).toBe("webhook");
      expect(r.url).toBe("https://example.com/hook");
      expect(r.headers).toBeUndefined();

      const r2: WebhookRecipient = { type: "webhook", url: "https://example.com/hook", headers: { "X-Key": "abc" } };
      expect(r2.headers).toEqual({ "X-Key": "abc" });
    });

    it("Recipient discriminated union narrows correctly", () => {
      const recipients: Recipient[] = [
        { type: "email", address: "a@b.com" },
        { type: "slack", channel: "#dev" },
        { type: "webhook", url: "https://hook.example.com" },
      ];

      const emails = recipients.filter((r): r is EmailRecipient => r.type === "email");
      expect(emails.length).toBe(1);
      expect(emails[0].address).toBe("a@b.com");

      const slacks = recipients.filter((r): r is SlackRecipient => r.type === "slack");
      expect(slacks.length).toBe(1);
      expect(slacks[0].channel).toBe("#dev");
    });
  });

  describe("ScheduledTask shape", () => {
    it("has all required fields", () => {
      const task: ScheduledTask = {
        id: "uuid",
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
      };
      expect(task.id).toBe("uuid");
      expect(task.enabled).toBe(true);
    });
  });

  describe("ScheduledTaskRun shape", () => {
    it("has all required fields", () => {
      const run: ScheduledTaskRun = {
        id: "run-uuid",
        taskId: "task-uuid",
        startedAt: "2024-01-01T09:00:00Z",
        completedAt: "2024-01-01T09:00:30Z",
        status: "success",
        conversationId: null,
        actionId: null,
        error: null,
        tokensUsed: 1500,
        createdAt: "2024-01-01T09:00:00Z",
      };
      expect(run.status).toBe("success");
      expect(run.tokensUsed).toBe(1500);
    });
  });
});
