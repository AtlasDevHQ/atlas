/**
 * Agent Auth → admin-action audit bridge (#4412 / #2058, Slice 4).
 *
 * Drives {@link createAgentAuthAuditor} with fully-injected seams — a spy
 * `emit`, a controllable `isEnabled`, and a small `executeSummaryInterval` — so
 * every assertion is self-contained with no settings DB, no Better Auth, and no
 * top-level singleton mutation. The mappings are asserted against the SAME
 * `ADMIN_ACTIONS.agent.*` catalog production uses, so a catalog rename is a RED
 * test rather than a silent drift.
 */

import { describe, it, expect } from "bun:test";
import type { AgentAuthEvent } from "@better-auth/agent-auth";

import {
  createAgentAuthAuditor,
  type AgentAuthAuditor,
} from "@atlas/api/lib/auth/agent-auth-audit";
import { ADMIN_ACTIONS, type AdminActionEntry, type AdminActionType } from "@atlas/api/lib/audit";

/** Build an auditor whose emitted rows land in `rows`, enabled unless overridden. */
function harness(
  overrides: { enabled?: boolean; interval?: number; maxTrackedKeys?: number } = {},
): { auditor: AgentAuthAuditor; rows: AdminActionEntry[] } {
  const rows: AdminActionEntry[] = [];
  const auditor = createAgentAuthAuditor({
    emit: (entry) => rows.push(entry),
    isEnabled: async () => overrides.enabled ?? true,
    executeSummaryInterval: overrides.interval,
    maxTrackedKeys: overrides.maxTrackedKeys,
  });
  return { auditor, rows };
}

const executeEvent = (
  over: Partial<Extract<AgentAuthEvent, { type: "capability.executed" }>> = {},
): AgentAuthEvent => ({
  type: "capability.executed",
  capability: "getReports",
  agentId: "agent_1",
  status: "success",
  ...over,
});

describe("agent-auth audit — lifecycle mappings", () => {
  const cases: Array<{ event: AgentAuthEvent; action: AdminActionType; targetId: string }> = [
    {
      event: { type: "agent.created", actorId: "user_1", agentId: "agent_1", hostId: "host_1" },
      action: ADMIN_ACTIONS.agent.register,
      targetId: "agent_1",
    },
    {
      event: { type: "agent.revoked", actorId: "user_1", agentId: "agent_1", hostId: "host_1" },
      action: ADMIN_ACTIONS.agent.revoke,
      targetId: "agent_1",
    },
    {
      event: { type: "host.enrolled", hostId: "host_1", actorType: "system" },
      action: ADMIN_ACTIONS.agent.hostEnroll,
      targetId: "host_1",
    },
    {
      event: { type: "host.revoked", actorId: "user_1", hostId: "host_1" },
      action: ADMIN_ACTIONS.agent.hostRevoke,
      targetId: "host_1",
    },
    {
      event: { type: "capability.requested", actorType: "agent", actorId: "user_1", agentId: "agent_1" },
      action: ADMIN_ACTIONS.agent.capabilityRequest,
      targetId: "agent_1",
    },
    {
      event: { type: "capability.approved", actorId: "user_1", agentId: "agent_1" },
      action: ADMIN_ACTIONS.agent.capabilityApprove,
      targetId: "agent_1",
    },
    {
      event: { type: "capability.denied", actorId: "user_1", agentId: "agent_1" },
      action: ADMIN_ACTIONS.agent.capabilityDeny,
      targetId: "agent_1",
    },
    {
      event: { type: "capability.revoked", actorId: "user_1", agentId: "agent_1", hostId: "host_1" },
      action: ADMIN_ACTIONS.agent.capabilityRevoke,
      targetId: "agent_1",
    },
  ];

  for (const { event, action, targetId } of cases) {
    it(`maps ${event.type} → ${action}`, async () => {
      const { auditor, rows } = harness();
      await auditor.handleEvent(event);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actionType).toBe(action);
      expect(rows[0]!.targetType).toBe("agent");
      expect(rows[0]!.targetId).toBe(targetId);
      // Lifecycle rows default to success (a deny is a decision, not a failure).
      expect(rows[0]!.status).toBeUndefined();
    });
  }

  it("lifts the trustworthy identity fields into metadata and nests plugin metadata under detail", async () => {
    const { auditor, rows } = harness();
    await auditor.handleEvent({
      type: "capability.denied",
      actorId: "user_1",
      actorType: "user",
      agentId: "agent_1",
      metadata: { capabilities: ["getReports"], reason: "not needed" },
    });
    expect(rows[0]!.metadata).toEqual({
      actorId: "user_1",
      actorType: "user",
      agentId: "agent_1",
      detail: { capabilities: ["getReports"], reason: "not needed" },
    });
  });

  it("ignores event types that are not in the audited catalog", async () => {
    const { auditor, rows } = harness();
    for (const type of [
      "agent.updated",
      "agent.claimed",
      "host.created",
      "capability.granted",
      "approval.created",
    ] as const) {
      await auditor.handleEvent({ type, agentId: "agent_1" } as AgentAuthEvent);
    }
    expect(rows).toHaveLength(0);
  });
});

describe("agent-auth audit — execute sampling (AC #3)", () => {
  it("summarizes successful executes: one row per interval, not per call", async () => {
    const { auditor, rows } = harness({ interval: 3 });

    await auditor.handleEvent(executeEvent());
    await auditor.handleEvent(executeEvent());
    expect(rows).toHaveLength(0); // below the interval — no per-call rows

    await auditor.handleEvent(executeEvent());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actionType).toBe(ADMIN_ACTIONS.agent.capabilityExecute);
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.metadata).toMatchObject({
      capability: "getReports",
      sampled: true,
      representedExecuteCount: 3,
    });

    // Counter reset after a flush — the next two don't emit again.
    await auditor.handleEvent(executeEvent());
    await auditor.handleEvent(executeEvent());
    expect(rows).toHaveLength(1);
  });

  it("counts each capability independently", async () => {
    const { auditor, rows } = harness({ interval: 2 });
    await auditor.handleEvent(executeEvent({ capability: "getReports" }));
    await auditor.handleEvent(executeEvent({ capability: "listUsers" }));
    expect(rows).toHaveLength(0); // one of each — neither pair hit 2 yet
    await auditor.handleEvent(executeEvent({ capability: "getReports" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ capability: "getReports" });
  });

  it("counts each agentId independently for the same capability", async () => {
    const { auditor, rows } = harness({ interval: 2 });
    // Two different agents hammering the SAME capability must NOT be co-counted —
    // a regression that dropped the agentId half of the sampler key would emit a
    // spurious summary here.
    await auditor.handleEvent(executeEvent({ agentId: "agent_1", capability: "getReports" }));
    await auditor.handleEvent(executeEvent({ agentId: "agent_2", capability: "getReports" }));
    expect(rows).toHaveLength(0);
    // agent_1's second execute closes agent_1's window only.
    await auditor.handleEvent(executeEvent({ agentId: "agent_1", capability: "getReports" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ agentId: "agent_1", representedExecuteCount: 2 });
  });

  it("always emits a failure row for a failed execute, bypassing the sampler", async () => {
    const { auditor, rows } = harness({ interval: 100 });
    await auditor.handleEvent(
      executeEvent({ status: "error", error: "Upstream API error 500", durationMs: 42 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failure");
    expect(rows[0]!.metadata).toMatchObject({
      executeStatus: "error",
      sampled: false,
      representedExecuteCount: 1,
      error: "Upstream API error 500",
      durationMs: 42,
    });
  });

  it("scrubs a connection string out of a failure's error before persisting it", async () => {
    const { auditor, rows } = harness({ interval: 100 });
    await auditor.handleEvent(
      executeEvent({
        status: "error",
        error: "connect failed: postgres://svc:s3cr3t@10.0.0.4:5432/prod is unreachable",
      }),
    );
    expect(rows).toHaveLength(1);
    const persisted = String(rows[0]!.metadata?.error ?? "");
    expect(persisted).not.toContain("s3cr3t");
    expect(persisted).toContain("postgres://***@");
  });

  it("bounds sampler memory by clearing counters when the tracked-key cap is exceeded", async () => {
    // interval high enough that no pair flushes on its own; cap of 2 so the 3rd
    // distinct pair trips the wholesale clear. The sampler must keep working
    // (not corrupt) afterwards — a fresh pair still counts up and flushes.
    const { auditor, rows } = harness({ interval: 2, maxTrackedKeys: 2 });
    await auditor.handleEvent(executeEvent({ capability: "a" }));
    await auditor.handleEvent(executeEvent({ capability: "b" }));
    await auditor.handleEvent(executeEvent({ capability: "c" })); // size now 3 > cap → cleared
    expect(rows).toHaveLength(0);
    // Post-clear the sampler is intact: two executes of one pair still summarize.
    await auditor.handleEvent(executeEvent({ capability: "d" }));
    await auditor.handleEvent(executeEvent({ capability: "d" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ capability: "d", representedExecuteCount: 2 });
  });

  it("never records capability arguments or output in the audit metadata", async () => {
    const { auditor, rows } = harness({ interval: 1 });
    await auditor.handleEvent(
      executeEvent({
        arguments: { sql: "SELECT ssn FROM customers" },
        output: [{ ssn: "123-45-6789" }],
      }),
    );
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata ?? {};
    expect(meta).not.toHaveProperty("arguments");
    expect(meta).not.toHaveProperty("output");
    expect(JSON.stringify(meta)).not.toContain("123-45-6789");
  });
});

describe("agent-auth audit — fail-closed master gate (AC #4)", () => {
  it("emits no rows for any event when ATLAS_AGENT_AUTH_ENABLED is off", async () => {
    const { auditor, rows } = harness({ enabled: false, interval: 1 });
    await auditor.handleEvent({ type: "agent.created", agentId: "agent_1" });
    await auditor.handleEvent({ type: "capability.approved", actorId: "user_1", agentId: "agent_1" });
    await auditor.handleEvent(executeEvent());
    await auditor.handleEvent(executeEvent({ status: "error", error: "boom" }));
    expect(rows).toHaveLength(0);
  });
});
