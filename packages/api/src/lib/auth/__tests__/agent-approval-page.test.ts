/**
 * `resolveAgentApprovalPage` — the `deviceAuthorizationPage` URL for the Agent
 * Auth device-approval flow (#4411). Mirrors `device-verification-uri.test.ts`:
 * an absolute web-origin URL when the origin resolves, the bare relative path
 * only for a genuinely single-origin embedded deploy.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveAgentApprovalPage,
  AGENT_APPROVAL_PATH,
} from "@atlas/api/lib/auth/agent-approval-page";

describe("resolveAgentApprovalPage (#4411)", () => {
  it("returns an absolute web-origin URL when the web origin resolves", () => {
    expect(resolveAgentApprovalPage("https://app.useatlas.dev")).toBe(
      "https://app.useatlas.dev/agent/approve",
    );
  });

  it("targets the WEB origin, not the API origin (the page 404s on api.*)", () => {
    const uri = resolveAgentApprovalPage("https://app.staging.useatlas.dev");
    expect(uri).toBe("https://app.staging.useatlas.dev/agent/approve");
    expect(uri).not.toContain("api.");
  });

  it("strips a trailing slash so the URL never doubles up (`//agent/approve`)", () => {
    expect(resolveAgentApprovalPage("http://localhost:3000/")).toBe(
      "http://localhost:3000/agent/approve",
    );
  });

  it("falls back to the bare relative path for a single-origin embedded deploy (null origin)", () => {
    expect(resolveAgentApprovalPage(null)).toBe(AGENT_APPROVAL_PATH);
    expect(AGENT_APPROVAL_PATH).toBe("/agent/approve");
  });
});
