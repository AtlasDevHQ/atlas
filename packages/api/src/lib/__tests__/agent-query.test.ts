/**
 * Tests for `executeAgentQuery` actor binding (F-54 / F-55).
 *
 * Pins:
 *  - When an `actor` option is passed, it lands on the `RequestContext`
 *    `user` field that `getRequestContext()` returns inside the agent loop.
 *    This is the property that lets `checkApprovalRequired` see an `orgId`
 *    on the scheduler and chat-platform paths.
 *  - When no `actor` is passed but the parent context already has a `user`
 *    bound (e.g. the `/query` route has authenticated first), the parent
 *    user propagates instead of being shadowed. The previous implementation
 *    overwrote with `{ requestId }` only and lost the user.
 *  - `pendingApproval` from a tool result is surfaced on the returned
 *    `AgentQueryResult` so callers can fail-loud.
 */

import { describe, it, expect, mock } from "bun:test";

import type { RequestActor } from "@atlas/api/lib/logger";

const observedContexts: { requestId?: string; user?: { id: string; activeOrganizationId?: string } | undefined; actor?: RequestActor | undefined }[] = [];

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    const ctx = getRequestContext();
    observedContexts.push({
      ...(ctx?.requestId !== undefined ? { requestId: ctx.requestId } : {}),
      ...(ctx?.user !== undefined ? { user: { id: ctx.user.id, ...(ctx.user.activeOrganizationId !== undefined ? { activeOrganizationId: ctx.user.activeOrganizationId } : {}) } } : {}),
      ...(ctx?.actor !== undefined ? { actor: ctx.actor } : {}),
    });
    return {
      // #3750 — the real runAgent Object.assigns a `runId` onto its result.
      runId: "run-mock-1",
      text: Promise.resolve("done"),
      steps: Promise.resolve([
        {
          toolResults: [
            {
              toolName: "executeSQL",
              input: { sql: "SELECT * FROM customer_pii" },
              output: {
                success: false,
                approval_required: true,
                approval_request_id: "req-1",
                matched_rules: ["Block PII reads"],
                message: "Approval required: Block PII reads",
              },
            },
          ],
        },
      ]),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    };
  }),
}));

const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
const { withRequestContext } = await import("@atlas/api/lib/logger");
const { createAtlasUser } = await import("@atlas/api/lib/auth/types");

describe("executeAgentQuery actor binding", () => {
  it("F-54: binds the explicit actor onto RequestContext for the agent run", async () => {
    observedContexts.length = 0;
    const actor = createAtlasUser("user-abc", "managed", "user-abc@example.com", {
      role: "admin",
      activeOrganizationId: "org-abc",
    });
    await executeAgentQuery("how many customers?", "req-1", { actor });
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0].user?.id).toBe("user-abc");
    expect(observedContexts[0].user?.activeOrganizationId).toBe("org-abc");
  });

  it("propagates an inherited user from a parent withRequestContext when no actor is passed", async () => {
    observedContexts.length = 0;
    const user = createAtlasUser("user-parent", "managed", "user-parent@example.com", {
      activeOrganizationId: "org-parent",
    });
    await withRequestContext({ requestId: "outer", user }, async () => {
      await executeAgentQuery("query without explicit actor", "inner-req");
    });
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0].user?.id).toBe("user-parent");
    expect(observedContexts[0].user?.activeOrganizationId).toBe("org-parent");
  });

  it("#3615: stamps the explicit actorKind (scheduler) onto RequestContext for the agent run", async () => {
    observedContexts.length = 0;
    const actor = createAtlasUser("owner-1", "managed", "owner-1@example.com", {
      activeOrganizationId: "org-sched",
    });
    await executeAgentQuery("nightly report", "req-sched", { actor, actorKind: "scheduler" });
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0].actor).toEqual({ kind: "scheduler" });
  });

  it("#3615: propagates an inherited actor (human) when no actorKind is passed", async () => {
    observedContexts.length = 0;
    await withRequestContext(
      { requestId: "outer", actor: { kind: "human" } },
      async () => {
        await executeAgentQuery("API form of chat", "inner-req");
      },
    );
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0].actor).toEqual({ kind: "human" });
  });

  it("#3615: leaves actor unset when neither option nor parent context provides one (audit defaults to 'agent')", async () => {
    observedContexts.length = 0;
    await executeAgentQuery("bare agent run", "req-bare");
    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0].actor).toBeUndefined();
  });

  it("F-54/F-55: surfaces pendingApproval from tool results so callers can fail-loud", async () => {
    const actor = createAtlasUser("user-x", "managed", "user-x@example.com", { activeOrganizationId: "org-x" });
    const result = await executeAgentQuery("query that hits a rule", "req-2", { actor });
    expect(result.pendingApproval).toBeDefined();
    expect(result.pendingApproval?.requestId).toBe("req-1");
    expect(result.pendingApproval?.ruleName).toBe("Block PII reads");
    expect(result.pendingApproval?.matchedRules).toEqual(["Block PII reads"]);
  });

  it("#3750: surfaces the durable runId from runAgent and echoes conversationId for async-approval resume", async () => {
    const actor = createAtlasUser("user-r", "managed", "user-r@example.com", { activeOrganizationId: "org-r" });
    const result = await executeAgentQuery("parked query", "req-3", {
      actor,
      conversationId: "conv-abc",
    });
    // runId comes from runAgent's returned object; conversationId is echoed
    // from the option. Together they let a chat surface re-arm + resume.
    expect(result.runId).toBe("run-mock-1");
    expect(result.conversationId).toBe("conv-abc");
  });

  it("#3750: omits conversationId when none was supplied (a conversation-less turn has no resumable checkpoint)", async () => {
    const actor = createAtlasUser("user-r", "managed", "user-r@example.com", { activeOrganizationId: "org-r" });
    const result = await executeAgentQuery("no-conversation query", "req-4", { actor });
    expect(result.runId).toBe("run-mock-1");
    expect(result.conversationId).toBeUndefined();
  });
});
