/**
 * Reversibility guard for the Agent Auth seam (#4409 AC / #4408 AC4).
 *
 * The load-bearing invariant: Agent Auth plugs into the identity layer as a new
 * `AtlasUser` producer, and NO agent-auth / token / discovery knowledge leaks
 * into the enforcement core — the MCP dispatch gate, its declarative contract,
 * or RBAC/permissions. So a future switch to an OAuth-native (ID-JAG / auth.md)
 * agent-identity flow replaces the producer and touches none of those files.
 *
 * This is grep-assertable and is asserted here: the three quarantined files must
 * contain none of the agent-auth vocabulary. If a future change threads a token
 * shape or `/.well-known/agent-configuration` assumption into the gate, this
 * test goes RED and names the leak.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// packages/api/src/lib/auth/__tests__ → repo root is six levels up
// (__tests__ → auth → lib → src → api → packages → root).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..");

/**
 * The enforcement-core files that must stay ignorant of agent-auth. Paths are
 * repo-relative so the failure message points a maintainer straight at the file.
 */
const QUARANTINED_FILES = [
  "packages/mcp/src/dispatch-gate.ts",
  "packages/api/src/lib/mcp/dispatch-gate-contract.ts",
  "packages/api/src/lib/auth/permissions.ts",
] as const;

/**
 * Vocabulary that would signal an agent-auth leak into the enforcement core.
 * Case-insensitive. `agent-configuration` / `agentAuth` / the package name are
 * the discovery + plugin identifiers; the token/session/grant terms are the
 * shapes that must stay quarantined in the verifier + plugin.
 */
const FORBIDDEN_TERMS = [
  "agent-auth",
  "agentauth",
  "@better-auth/agent-auth",
  "agent-configuration",
  "agent-auth-verifier",
  "agent-auth-plugin",
  "agentsession",
  "capabilitygrant",
  "verifyagentrequest",
  "agent_auth",
] as const;

describe("agent-auth seam quarantine (#4409 reversibility)", () => {
  for (const rel of QUARANTINED_FILES) {
    it(`${rel} contains no agent-auth vocabulary`, () => {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8").toLowerCase();
      const leaks = FORBIDDEN_TERMS.filter((term) => source.includes(term.toLowerCase()));
      expect(
        leaks,
        `${rel} leaked agent-auth vocabulary: ${leaks.join(", ")}. The enforcement ` +
          `core must consume only the AtlasUser abstraction — keep agent-auth ` +
          `knowledge inside the verifier + plugin.`,
      ).toEqual([]);
    });
  }
});
