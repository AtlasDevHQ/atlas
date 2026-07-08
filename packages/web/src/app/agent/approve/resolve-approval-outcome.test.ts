import { describe, it, expect } from "bun:test";
import { resolveApprovalOutcome } from "./resolve-approval-outcome";

describe("resolveApprovalOutcome (#4411)", () => {
  it("200 { status: approved } → resolved/approved", () => {
    expect(resolveApprovalOutcome({ status: 200, body: { status: "approved" } })).toEqual({
      kind: "resolved",
      decision: "approved",
    });
  });

  it("200 { status: denied } → resolved/denied", () => {
    expect(resolveApprovalOutcome({ status: 200, body: { status: "denied" } })).toEqual({
      kind: "resolved",
      decision: "denied",
    });
  });

  it("gate 404 { error: not_found } → unavailable (the surface was toggled off mid-flow)", () => {
    expect(resolveApprovalOutcome({ status: 404, body: { error: "not_found" } })).toEqual({
      kind: "unavailable",
    });
  });

  it("stale-agent 404 { error: agent_not_found } → error, NOT unavailable", () => {
    const out = resolveApprovalOutcome({
      status: 404,
      body: { error: "agent_not_found", message: "Agent has been revoked." },
    });
    // A revoked/stale link must not read as "the feature is disabled".
    expect(out).toEqual({ kind: "error", message: "Agent has been revoked." });
  });

  it("401 → an actionable 'session expired, sign in again' error", () => {
    const out = resolveApprovalOutcome({ status: 401, body: { error: "unauthorized" } });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message.toLowerCase()).toContain("sign in");
  });

  it("4xx error envelope → error carrying the server message", () => {
    const out = resolveApprovalOutcome({
      status: 403,
      body: { error: "invalid_user_code", message: "That code is invalid or expired." },
    });
    expect(out).toEqual({ kind: "error", message: "That code is invalid or expired." });
  });

  it("4xx with only an error code → error carrying the code", () => {
    expect(resolveApprovalOutcome({ status: 400, body: { error: "invalid_request" } })).toEqual({
      kind: "error",
      message: "invalid_request",
    });
  });

  it("non-JSON / empty error body → actionable fallback message", () => {
    const out = resolveApprovalOutcome({ status: 500, body: null });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message.length).toBeGreaterThan(0);
  });

  it("2xx with an unexpected status value → error, not a false success", () => {
    const out = resolveApprovalOutcome({ status: 200, body: { status: "weird" } });
    expect(out.kind).toBe("error");
  });
});
