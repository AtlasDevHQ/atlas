/**
 * #4829 + #4828 — a sandbox that cannot be constructed must make explore REFUSE,
 * and must be REPORTED as refusing. Two ends of one design flaw: `_nsjailFailed`
 * was overloaded as both "do not retry this backend" and "the operator's pin no
 * longer applies", and `firstAvailableBackend()` returned `null` on exhaustion
 * while ignoring `plan.onExhausted`, so a fail-closed plan was indistinguishable
 * from a just-bash deployment.
 *
 * Every assertion here is on the RUNTIME CONSEQUENCE, never on log text. That is
 * deliberate and is #4829's stated acceptance criterion: the bug shipped green
 * past a suite whose nsjail-degradation cases asserted what boot *said*. A log
 * line is not a security boundary, and a test that greps one cannot tell a fixed
 * build from a broken one.
 *
 * The mechanism that makes these tests honest: `ATLAS_SEMANTIC_ROOT` points at a
 * real temp dir, so the just-bash backend genuinely executes `echo`. If the
 * fail-open regressed, the chain would reach just-bash and MARKER would appear
 * in the output — so `expect(result).not.toContain(MARKER)` fails loudly rather
 * than passing on a technicality. Asserting only on the error string would stay
 * green against a build that ran the command AND logged an error.
 */
import { describe, expect, it, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setConfigForTest, _resetConfig, type ResolvedConfig } from "@atlas/api/lib/config";

// Only reached by the config-priority case; throwing keeps that branch
// deterministic without a live Vercel SDK.
void mock.module("@atlas/api/lib/tools/explore-sandbox", () => ({
  createSandboxBackend: async (): Promise<never> => {
    throw new Error("vercel sandbox unreachable (test)");
  },
}));

const MARKER = "atlas_fail_closed_marker";

let testCounter = 0;
async function freshExploreModule() {
  testCounter++;
  return import(`@atlas/api/lib/tools/explore?t=fail-closed-${testCounter}`);
}

function runExplore(mod: Awaited<ReturnType<typeof freshExploreModule>>): Promise<unknown> {
  return mod.explore.execute(
    { command: `echo ${MARKER}` },
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );
}

describe("ATLAS_SANDBOX=nsjail refuses rather than degrading (#4829)", () => {
  const originalEnv = { ...process.env };
  let semanticRoot: string;

  beforeEach(() => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TOKEN;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    _resetConfig();
    // A real OverlayFs root, so just-bash WOULD run the command if the chain
    // ever reached it. This is what makes the negative assertions meaningful.
    semanticRoot = mkdtempSync(join(tmpdir(), "atlas-explore-fc-"));
    writeFileSync(join(semanticRoot, "catalog.yml"), "tables: []\n");
    process.env.ATLAS_SEMANTIC_ROOT = semanticRoot;
    process.env.ATLAS_SANDBOX = "nsjail";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetConfig();
    rmSync(semanticRoot, { recursive: true, force: true });
  });

  it("throws on every request when the namespace capability probe failed", async () => {
    const mod = await freshExploreModule();

    // Exactly what `checkExplicitNsjail()` does on the capability-failure arm
    // (`testNsjailCapabilities()` not ok). Calling the same seam the startup
    // probe calls is the point: this reproduces the boot path's effect on the
    // module without needing to boot.
    mod.markNsjailFailed();

    // "on EVERY request" is part of the acceptance criterion, and the backend
    // cache makes the first and subsequent calls structurally different paths —
    // a fix that only refused once would leave the deployment exposed from the
    // second request onward.
    for (const attempt of [1, 2, 3]) {
      const result = await runExplore(mod);

      expect(typeof result, `attempt ${attempt}`).toBe("string");
      // THE security assertion: the agent's shell command never executed.
      expect(result, `attempt ${attempt} executed the command`).not.toContain(MARKER);
      expect(result, `attempt ${attempt}`).toContain("Explore tool is unavailable");
      expect(result, `attempt ${attempt}`).toContain("nsjail was explicitly requested");
    }
  });

  it("reports fail-closed, not just-bash, once nsjail is marked failed", async () => {
    const mod = await freshExploreModule();

    // Pre-condition: without the failure the pin resolves to nsjail. Asserting
    // it makes the post-condition a real transition rather than possibly-already
    // -true.
    expect(mod.getExploreBackendType()).toBe("nsjail");

    mod.markNsjailFailed();

    // `just-bash` here was #4829's fail-open AND #4828's false report at once:
    // it claimed an unsandboxed-but-working deploy for one that runs nothing.
    expect(mod.getExploreBackendType()).toBe("fail-closed");
  });

  it("keeps the pin armed when nsjail is merely undetected (the #4824 arm)", async () => {
    // The missing-BINARY arm must be untouched: #4824 deliberately does not call
    // markNsjailFailed() there, so the pin stays armed and reports `nsjail`.
    // Guarding it here means a future "simplification" that collapses the two
    // arms into one fails this file rather than silently reintroducing the
    // divergence #4824 closed.
    const fs = await import("fs");
    const spy = spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    process.env.PATH = "";

    const mod = await freshExploreModule();
    expect(mod.getExploreBackendType()).toBe("nsjail");

    // …and it still refuses to run rather than degrading.
    const result = await runExplore(mod);
    expect(result).not.toContain(MARKER);
    expect(result).toContain("nsjail was explicitly requested");

    spy.mockRestore();
  });
});

describe("an exhausted fail-closed pin is not a just-bash deployment (#4828)", () => {
  const originalEnv = { ...process.env };
  let semanticRoot: string;

  beforeEach(() => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TOKEN;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    _resetConfig();
    semanticRoot = mkdtempSync(join(tmpdir(), "atlas-explore-fc2-"));
    writeFileSync(join(semanticRoot, "catalog.yml"), "tables: []\n");
    process.env.ATLAS_SEMANTIC_ROOT = semanticRoot;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetConfig();
    rmSync(semanticRoot, { recursive: true, force: true });
  });

  it("reports fail-closed when the pinned backend's credential is missing", async () => {
    // The exact staging/prod shape from #4828: `deploy/api/atlas.config.ts` pins
    // ["vercel-sandbox"] with no just-bash, and VERCEL_TOKEN — a per-service
    // Railway secret that shared vars do not inherit — is dropped on one region.
    // No Vercel env is set here, so `useVercelSandbox()` is false.
    _setConfigForTest({
      sandbox: { priority: ["vercel-sandbox"] },
      deployMode: "saas",
    } as unknown as ResolvedConfig);

    const mod = await freshExploreModule();

    // Was "just-bash": `/api/health` reported `backend: just-bash`,
    // `isolated: false`, `status: degraded` — a healthy-looking unsandboxed
    // deploy — for a region where explore throws on every request.
    expect(mod.getExploreBackendType()).toBe("fail-closed");

    // And the report matches reality: nothing runs.
    const result = await runExplore(mod);
    expect(result).not.toContain(MARKER);
    expect(result).toContain("All backends in sandbox.priority");
  });

  it("still reports just-bash for a pin that genuinely permits it", async () => {
    // The inverse, and the reason this cannot be fixed by reporting fail-closed
    // whenever nothing is available: an operator who kept just-bash in the list
    // really is running an unsandboxed deployment, and flattening that into
    // fail-closed would hide it. `onExhausted` is the discriminator.
    _setConfigForTest({
      sandbox: { priority: ["sidecar", "just-bash"] },
      deployMode: "self-hosted",
    } as unknown as ResolvedConfig);

    const mod = await freshExploreModule();

    expect(mod.getExploreBackendType()).toBe("just-bash");

    const result = await runExplore(mod);
    expect(result).toContain(MARKER);
  });
});
