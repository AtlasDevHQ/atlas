/**
 * #4187 AC1 — "explore and python resolve the same backend for the same
 * env/config." Both tools feed the ONE shared `planSandboxSelection` policy, so
 * the only remaining drift vector is their two snapshot builders
 * (`snapshotExploreSandboxEnv` vs `snapshotPythonSandboxEnv`). This test drives
 * a matrix of env/config states through BOTH builders and asserts they produce
 * the SAME plan — so a future edit to one builder's detection semantics can't
 * silently reintroduce the exact divergence this issue fixed.
 *
 * The two builders intentionally differ on `nsjailAvailable` (explore feeds the
 * pin-inclusive `useNsjail()`, python the pure `isNsjailAvailable()`) and on
 * `nsjailFailed` (python has no runtime-degradation flag). The matrix here keeps
 * nsjail's binary absent (PATH cleared) and `_nsjailFailed` false (fresh module),
 * so those documented differences don't apply and the resulting PLANS must match
 * exactly — which is the property AC1 actually cares about.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  getRequestContext: () => undefined,
}));

void mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

const { planSandboxSelection } = await import("@atlas/api/lib/tools/backends/selection");
const { snapshotExploreSandboxEnv } = await import("@atlas/api/lib/tools/explore");
const { snapshotPythonSandboxEnv } = await import("@atlas/api/lib/tools/python");
const { _setConfigForTest, _resetConfig } = await import("@atlas/api/lib/config");

async function bothPlans() {
  const explorePlan = planSandboxSelection(snapshotExploreSandboxEnv());
  const pythonPlan = planSandboxSelection(await snapshotPythonSandboxEnv());
  const shape = (p: typeof explorePlan) => ({
    source: p.source,
    onExhausted: p.onExhausted,
    steps: p.steps.map((s) => ({ kind: s.kind, hardFail: s.hardFail })),
  });
  return { explore: shape(explorePlan), python: shape(pythonPlan) };
}

describe("explore + python resolve the same backend plan (#4187 AC1)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetConfig();
    // Neutralize all backend inputs; each case sets exactly what it exercises.
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TOKEN;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    // nsjail binary deterministically absent (both builders detect false).
    process.env.PATH = "";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetConfig();
  });

  // 2×2×2 over the env-driven default chain (Vercel × sidecar × explicit-nsjail).
  const vercelStates = [false, true];
  const sidecarStates = [false, true];
  const explicitNsjailStates = [false, true];

  for (const vercel of vercelStates) {
    for (const sidecar of sidecarStates) {
      for (const explicitNsjail of explicitNsjailStates) {
        it(`agrees for vercel=${vercel} sidecar=${sidecar} explicitNsjail=${explicitNsjail}`, async () => {
          if (vercel) process.env.ATLAS_RUNTIME = "vercel";
          if (sidecar) process.env.ATLAS_SANDBOX_URL = "http://sidecar.test";
          if (explicitNsjail) process.env.ATLAS_SANDBOX = "nsjail";

          const { explore, python } = await bothPlans();
          expect(python).toEqual(explore);
        });
      }
    }
  }

  it("agrees on a config-priority pin (SaaS deny-all)", async () => {
    _setConfigForTest({
      sandbox: { priority: ["vercel-sandbox"] },
      deployMode: "saas",
    } as unknown as Parameters<typeof _setConfigForTest>[0]);
    process.env.ATLAS_RUNTIME = "vercel";

    const { explore, python } = await bothPlans();
    expect(python).toEqual(explore);
    expect(python.source).toBe("config-priority");
    expect(python.onExhausted).toBe("fail-closed");
  });

  it("agrees on a config-priority list that includes just-bash", async () => {
    _setConfigForTest({
      sandbox: { priority: ["sidecar", "just-bash"] },
      deployMode: "self-hosted",
    } as unknown as Parameters<typeof _setConfigForTest>[0]);

    const { explore, python } = await bothPlans();
    expect(python).toEqual(explore);
    expect(python.onExhausted).toBe("just-bash");
  });
});
