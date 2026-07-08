import { describe, it, expect } from "bun:test";
import { resolvePendingApproval } from "./resolve-pending-approval";

const deviceRequest = (overrides: Record<string, unknown> = {}) => ({
  approval_id: "appr_1",
  method: "device_authorization",
  agent_id: "agent_1",
  agent_name: "Reporting Agent",
  binding_message: "Weekly revenue report",
  capabilities: ["getMe", "getDashboards"],
  capability_reasons: { getMe: "Identify the caller", getDashboards: "Read your dashboards" },
  expires_in: 300,
  created_at: "2026-07-08T00:00:00Z",
  ...overrides,
});

describe("resolvePendingApproval (#4411)", () => {
  it("returns the matching device-authorization request, normalized", () => {
    const out = resolvePendingApproval({ requests: [deviceRequest()] }, "agent_1");
    expect(out.kind).toBe("ready");
    if (out.kind !== "ready") throw new Error("expected ready");
    expect(out.request).toEqual({
      approvalId: "appr_1",
      agentId: "agent_1",
      agentName: "Reporting Agent",
      bindingMessage: "Weekly revenue report",
      capabilities: ["getMe", "getDashboards"],
      capabilityReasons: { getMe: "Identify the caller", getDashboards: "Read your dashboards" },
      expiresIn: 300,
    });
  });

  it("picks the request for the requested agent when several are pending", () => {
    const out = resolvePendingApproval(
      {
        requests: [
          deviceRequest({ approval_id: "appr_other", agent_id: "agent_2" }),
          deviceRequest({ approval_id: "appr_mine", agent_id: "agent_1" }),
        ],
      },
      "agent_1",
    );
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") expect(out.request.approvalId).toBe("appr_mine");
  });

  it("ignores CIBA requests — only device_authorization is approvable here", () => {
    const out = resolvePendingApproval(
      { requests: [deviceRequest({ method: "ciba" })] },
      "agent_1",
    );
    expect(out.kind).toBe("not-found");
  });

  it("not-found when no request matches the agent id", () => {
    const out = resolvePendingApproval({ requests: [deviceRequest()] }, "agent_999");
    expect(out.kind).toBe("not-found");
  });

  it("not-found (never throws) on a malformed payload", () => {
    expect(resolvePendingApproval(null, "agent_1").kind).toBe("not-found");
    expect(resolvePendingApproval({}, "agent_1").kind).toBe("not-found");
    expect(resolvePendingApproval({ requests: "nope" }, "agent_1").kind).toBe("not-found");
    expect(resolvePendingApproval({ requests: [42, null] }, "agent_1").kind).toBe("not-found");
  });

  it("not-found when the agent id is empty", () => {
    expect(resolvePendingApproval({ requests: [deviceRequest()] }, "").kind).toBe("not-found");
  });

  it("tolerates missing optional fields (null agent_name / reasons / message)", () => {
    const out = resolvePendingApproval(
      {
        requests: [
          {
            approval_id: "appr_1",
            method: "device_authorization",
            agent_id: "agent_1",
            agent_name: null,
            binding_message: null,
            capabilities: ["getMe"],
            capability_reasons: null,
            expires_in: 300,
          },
        ],
      },
      "agent_1",
    );
    expect(out.kind).toBe("ready");
    if (out.kind === "ready") {
      expect(out.request.agentName).toBeNull();
      expect(out.request.bindingMessage).toBeNull();
      expect(out.request.capabilityReasons).toEqual({});
    }
  });
});
