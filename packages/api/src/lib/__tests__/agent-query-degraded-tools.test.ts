/**
 * #4941 — a degraded tool load on a HEADLESS surface reaches the model.
 *
 * `buildRegistry` authors a warning addressed to the agent ("...are unavailable
 * for this session. Inform the user and suggest they check server logs or retry
 * later"), and `api/routes/chat.ts` threads it into `runAgent({ warnings })` so
 * a web user hears "temporarily unavailable, retry". Every headless surface that
 * BUILDS a registry — the SDK query route, Slack, MCP, the scheduler — goes
 * through `executeAgentQuery` (the chat-platform approval resume calls the seam
 * directly, and is covered by its own file), which resolved a seam that
 * returned a bare registry and dropped the warnings at the destructure. The
 * agent then reported
 * the capability as ABSENT rather than degraded: a wrong explanation, not a
 * missing one, which is what makes it a truthfulness bug rather than a papercut.
 * (`ee/src/proactive/answer-adapter.ts` is headless too, but passes a STATIC
 * registry — no build to fail, so nothing to relay.)
 *
 * Own file because proving it needs the action-tool module to actually FAIL,
 * and `mock.module` is file-wide: `lib/tools/__tests__/registry.test.ts` mocks
 * that same specifier to a WORKING pair, which is what makes its
 * `includeActions` assertions meaningful. The two mocks cannot coexist.
 *
 * The assertion is on what `runAgent` RECEIVES, not on what the registry
 * builder returns — "the warning was produced" was already true before the fix.
 * The remaining hop, `runAgent({ warnings })` → `## Warnings` in the prompt the
 * model is handed, is pinned by `agent-context-warnings.test.ts`; without that
 * this file (and its two siblings) would all stay green if the forwarding were
 * deleted.
 *
 * The real logger is deliberately NOT mocked here: the failing action load must
 * still emit its operator-facing `error` line, and asserting the user-facing
 * half while silencing the operator half would miss the point of the issue. The
 * pino line in this file's output is expected.
 */

import { describe, it, expect, mock } from "bun:test";

/**
 * The failure being modelled: the action barrel does not load. A throwing
 * factory makes the `await import("./actions")` inside `buildRegistry` reject,
 * which is the branch that authors the warning — the same shape as a missing
 * transitive dep or a module-scope throw in `jira.ts` / `email.ts` on a
 * misconfigured box.
 *
 * Deliberately not a partial mock of the barrel's real exports: there is no
 * export surface to keep faithful when the premise is that the module is
 * unusable, and a partial mock would fail with a DIFFERENT error ("Export named
 * 'X' not found") that this file would then be quietly testing instead.
 */
void mock.module("@atlas/api/lib/tools/actions", () => {
  throw new Error("simulated action-module load failure (#4941)");
});

/** Every `runAgent` options bag the surface produced, in call order. */
const runAgentCalls: { tools?: { getAll(): Record<string, unknown> }; warnings?: string[] }[] = [];

// Partial mock of `lib/agent`, deliberately: `runAgent` is the only symbol any
// module in this file's reachable graph imports from it (`agent-query.ts:9`), so
// the "Export named 'X' not found" failure mode that bit `resume-turn.test.ts`
// cannot fire here. Mocking the full ~11-export surface would drag the real
// agent module graph in for no gain. If a future import from `lib/agent` appears
// under `agent-query.ts`, this comment is where to widen the mock.
void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(async (args: { tools?: { getAll(): Record<string, unknown> }; warnings?: string[] }) => {
    runAgentCalls.push(args);
    return {
      runId: "run-degraded-1",
      text: Promise.resolve("done"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    };
  }),
}));

const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
const { buildHeadlessRegistry } = await import("@atlas/api/lib/tools/registry");

/** Run `fn` with the given env keys set/cleared, restoring them afterwards. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ACTION_WARNING = "The operator action tools (createJiraTicket, sendEmailReport) failed to load";

describe("#4941 — headless surfaces relay a degraded tool load", () => {
  it("the headless seam surfaces buildRegistry's action-tool warning to its caller", async () => {
    await withEnv({ ATLAS_ACTIONS_ENABLED: "true" }, async () => {
      const { registry, warnings } = await buildHeadlessRegistry();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(ACTION_WARNING);
      // Degraded, not dead. The read surface is intact, which is exactly why
      // "I can't do that" was the wrong thing for the model to say.
      const names = Object.keys(registry.getAll());
      expect(names).toContain("executeSQL");
      expect(names).not.toContain("sendEmailReport");
    });
  });

  it("executeAgentQuery threads the warning into the agent's context", async () => {
    runAgentCalls.length = 0;
    await withEnv({ ATLAS_ACTIONS_ENABLED: "true" }, async () => {
      await executeAgentQuery("email me the Q3 numbers", "req-degraded");
    });

    expect(runAgentCalls).toHaveLength(1);
    const warnings = runAgentCalls[0]!.warnings;
    expect(
      warnings,
      "the headless turn ran with a degraded tool set and told the model nothing about it",
    ).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain(ACTION_WARNING);
    // The instruction half is what makes it relayable copy rather than an
    // operator log line; dropping it leaves the model free to invent a reason.
    // Both halves matter: the second stops the model generalizing "the action
    // tools are gone" into "email is gone", when the core `sendEmail` is right
    // there in its tool list.
    expect(warnings![0]).toContain("temporarily unavailable");
    expect(warnings![0]).toContain("do NOT tell the user that one of them is unavailable");
  });

  it("a healthy turn passes no warnings — the signal is not always-on", async () => {
    // Without this, "warnings is populated" is satisfiable by a surface that
    // always warns, which would open every headless answer with an apology.
    // `ATLAS_ACTIONS_ENABLED` unset means the failing module is never imported.
    runAgentCalls.length = 0;
    await withEnv({ ATLAS_ACTIONS_ENABLED: undefined }, async () => {
      await executeAgentQuery("how many customers?", "req-healthy");
    });

    expect(runAgentCalls).toHaveLength(1);
    expect(runAgentCalls[0]!.warnings).toBeUndefined();
    // Not vacuous: the turn really did run the headless registry.
    expect(Object.keys(runAgentCalls[0]!.tools!.getAll())).toContain("executeSQL");
  });
});
