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
 * real temp dir, so the just-bash backend genuinely executes `echo`. The
 * regression this guards is a fall-through to just-bash, which RETURNS the
 * command's output — so `expect(result).not.toContain(MARKER)` goes red on the
 * actual fail-open rather than passing on a technicality. (It proves no backend
 * produced the output, not that no process ever ran; for the fall-through class
 * of regression those coincide.)
 *
 * The positive control that keeps those negative assertions from being vacuous
 * is "still reports just-bash for a pin that genuinely permits it" in the second
 * describe — it asserts MARKER DOES appear. Deleting or skipping it silently
 * turns every `not.toContain(MARKER)` here into a tautology.
 */
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setConfigForTest, _resetConfig, type ResolvedConfig } from "@atlas/api/lib/config";

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

    // "on EVERY request" is part of the acceptance criterion. The refusal must be
    // monotonic: `getExploreBackend`'s promise `.catch` deletes the failed cache
    // entry, so each attempt re-walks the plan from scratch rather than replaying
    // a cached rejection. A fix that refused once and then let a later walk fall
    // through would leave the deployment exposed from the second request onward.
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
    // A real, executable path, so `findNsjailBinary()` genuinely succeeds. This
    // case is about the RUNTIME-failure transition, so it must start from a
    // deployment whose binary is present — since #4834 the reporting predicate
    // probes for it, and a case that skipped this would start at `fail-closed`
    // for the wrong reason and assert a transition that never happened.
    process.env.ATLAS_NSJAIL_PATH = "/bin/sh";

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

  it("reports fail-closed AND refuses when the pinned binary is missing (#4834)", async () => {
    // The missing-BINARY arm. This was the KNOWN GAP: it reported `nsjail` — so
    // `/api/health` claimed `isolated: true`, `sandbox.status: "healthy"`,
    // `status: "ok"` — while explore refused every request. Same shape as #4828
    // one arm over, and the last place boot and health disagreed.
    //
    // #4834 closed it by redefining the reporting predicate:
    // `isBackendAvailable("nsjail")` used to answer `pin || useNsjail()` and now
    // probes the binary, so the operator's INTENT can no longer masquerade as
    // capability. Nothing is marked failed and nothing is booted here — the
    // absent binary alone is what makes the resolver say `fail-closed`, which is
    // exactly why this fix needs no boot pre-flight to have run.
    //
    // The binary is made genuinely absent, and unlike before that is now the
    // MECHANISM rather than belt-and-braces: `accessSync` throws for every
    // candidate and `PATH` is empty, so `findNsjailBinary()` returns null. Undo
    // either and this case stops testing anything.
    const fs = await import("fs");
    const spy = spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    process.env.PATH = "";

    try {
      const mod = await freshExploreModule();

      // Half one — the REPORT. `/api/health` reads this same function, and gets
      // it right on the very first call, with no probe and no prior request.
      expect(mod.getExploreBackendType()).toBe("fail-closed");
      // The flag stays clear: this is a CONFIGURATION state, not a runtime
      // failure, and #4834 kept that distinction rather than blurring it.
      expect(mod.snapshotExploreSandboxEnv().nsjailFailed).toBe(false);

      // Half two — the RUNTIME CONSEQUENCE, asserted alongside the report rather
      // than in a separate case, because the bug was precisely the two halves
      // disagreeing. `just-bash` would genuinely run the command against the
      // real temp semantic root (see this file's header), so `not.toContain`
      // fails loudly on a fall-through instead of passing on a technicality.
      //
      // Looped like its sibling above: "refuses on EVERY request" is the
      // acceptance criterion, and `getExploreBackend`'s `.catch` drops the
      // failed cache entry so each attempt re-walks the plan from scratch.
      for (const attempt of [1, 2, 3]) {
        const result = await runExplore(mod);
        expect(result, `attempt ${attempt} executed the command`).not.toContain(MARKER);
        expect(result, `attempt ${attempt}`).toContain("Explore tool is unavailable");
        expect(result, `attempt ${attempt}`).toContain("nsjail was explicitly requested");

        // Only the FIRST attempt carries the specific remediation. Construction
        // is still attempted under the pin (`tryCreateBackend` gates on
        // `useNsjail()`, which #4834 left pin-inclusive), so attempt 1 raises
        // "nsjail binary not found. Install nsjail or set ATLAS_NSJAIL_PATH" —
        // and that failure latches `_nsjailFailed`, so attempts 2+ short-circuit
        // to the generic "previous initialization failed". Pre-existing, and
        // deliberately left alone here: it is a message-quality wart on the
        // repeat path, not part of this fix, and asserting the generic string
        // would pin a behaviour worth improving later.
        if (attempt === 1) {
          expect(result, "first attempt must name the remediation").toContain(
            "ATLAS_NSJAIL_PATH",
          );
        }
      }
    } finally {
      spy.mockRestore();
    }
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
