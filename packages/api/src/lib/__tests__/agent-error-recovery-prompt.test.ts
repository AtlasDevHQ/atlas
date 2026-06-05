/**
 * #3181 — the agent's "Error Recovery" prompt block must distinguish an
 * infrastructure outage (datasource unreachable / pool exhausted) from a fixable
 * query error. On an outage the agent should STOP and report, not burn its retry
 * + step budget reformulating SQL it cannot fix.
 *
 * Prompt-text contract test: build the system prompt for a plain-string provider
 * (openai — no cache-control wrapping) and assert the Error Recovery block now
 * carries the stop-and-report guidance referencing the tool's outage vocabulary
 * (`lib/tools/sql.ts` returns "Database unreachable at <host>" / pool-exhausted).
 */

import { describe, it, expect } from "bun:test";

// agent.ts reads env at module load; keep this set before the import below.
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

import { buildSystemParam } from "@atlas/api/lib/agent";

function systemText(): string {
  // openai is a non-cache provider → buildSystemParam returns a plain string.
  const system = buildSystemParam("openai");
  return typeof system === "string" ? system : String(system.content);
}

describe("agent Error Recovery prompt — infrastructure outage guidance (#3181)", () => {
  it("keeps the Error Recovery block", () => {
    expect(systemText()).toContain("Error Recovery");
  });

  it("recognizes datasource-unreachable / pool-exhausted as an outage, not a query error", () => {
    const text = systemText();
    expect(text).toMatch(/unreachable/i);
    expect(text).toMatch(/connection pool|pool is exhausted|pool is/i);
  });

  it("instructs the agent to stop and report rather than retry/modify the SQL", () => {
    const text = systemText();
    // The outage branch must tell the agent NOT to retry, and to surface the
    // outage to the user as temporarily unavailable.
    expect(text).toMatch(/do not retry|don't retry|not retry at all/i);
    expect(text).toMatch(/temporarily unavailable/i);
  });
});
