/**
 * #3406 — workspace-tier resolution of ATLAS_AGENT_MAX_STEPS.
 *
 * `getAgentMaxSteps` governs the agent loop's stopWhen budget. It is
 * workspace-scoped in the settings registry, so an org-scoped override must
 * apply to that workspace's runs: explicitly via the `orgId` parameter, and
 * implicitly via the request context's active organization (the agent loop
 * calls it with no argument from inside `withRequestContext`). Out-of-request
 * callers (the canonical eval CLI) keep the platform/env resolution.
 *
 * Uses the real settings module with the `_resetPool` injection pattern from
 * settings.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getAgentMaxSteps } from "@atlas/api/lib/agent";
import { withRequestContext } from "@atlas/api/lib/logger";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";

const ORG = "org-agent-steps-test";

const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

describe("getAgentMaxSteps — workspace tier (#3406)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origMaxSteps = process.env.ATLAS_AGENT_MAX_STEPS;

  beforeEach(async () => {
    delete process.env.ATLAS_AGENT_MAX_STEPS;
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
    await setSetting("ATLAS_AGENT_MAX_STEPS", "7", "test", ORG);
  });

  afterEach(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    if (origMaxSteps !== undefined) process.env.ATLAS_AGENT_MAX_STEPS = origMaxSteps;
    else delete process.env.ATLAS_AGENT_MAX_STEPS;
    _resetPool(null);
    _resetSettingsCache();
  });

  it("honors the workspace override when called with that orgId", () => {
    expect(getAgentMaxSteps(ORG)).toBe(7);
  });

  it("falls back to the request context's active organization when no orgId is passed", () => {
    const inRequest = withRequestContext(
      {
        requestId: "req-3406",
        user: {
          id: "u1",
          mode: "managed",
          label: "u1@example.com",
          activeOrganizationId: ORG,
        },
      },
      () => getAgentMaxSteps(),
    );
    expect(inRequest).toBe(7);
  });

  it("out-of-request callers keep the platform/env resolution (default 25)", () => {
    expect(getAgentMaxSteps()).toBe(25);
  });

  it("another org's override does not leak", () => {
    expect(getAgentMaxSteps("org-other")).toBe(25);
  });
});
