/**
 * Regression tests for #3177 — the explore default-priority backend chain
 * must fall through to the next backend when a higher-priority backend
 * (Vercel sandbox / sidecar) FAILS to initialize, instead of hard-failing
 * the explore tool.
 *
 * Before the fix, the default chain called `createSandboxBackend` /
 * `createSidecarBackend` without a local try/catch, so an init throw
 * escaped to the outer IIFE `.catch` (which only invalidates the cache and
 * rethrows) — degrading to "Explore tool is unavailable" instead of trying
 * nsjail / just-bash sitting right there in the chain. The config-priority
 * path (`tryCreateBackend`) always fell through correctly; the default
 * chain was asymmetric.
 *
 * The SaaS posture is the inverse and MUST stay: a pinned single-backend
 * priority (`sandbox.priority: ["vercel-sandbox"]`, deny-all) fails closed
 * with no insecure fallback. That goes through the config-priority path,
 * which this file also locks down.
 *
 * `createSandboxBackend` is mocked to throw so the Vercel branch is
 * deterministic without a live Vercel SDK. The sidecar branch is driven by
 * a malformed `ATLAS_SANDBOX_URL` (the real init throw — `new URL(...)`),
 * needing no module mock. nsjail is forced unavailable via an `fs.accessSync`
 * spy so the chain bottoms out at just-bash, which is pointed at a real
 * temp dir via `ATLAS_SEMANTIC_ROOT` so `echo` actually executes.
 */
import { describe, expect, it, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setConfigForTest, _resetConfig, type ResolvedConfig } from "@atlas/api/lib/config";

// Vercel backend always throws at init in this file — only invoked when the
// Vercel branch is reached (tests 2 + 3); the sidecar test never selects it.
mock.module("@atlas/api/lib/tools/explore-sandbox", () => ({
  createSandboxBackend: async (): Promise<never> => {
    throw new Error("vercel sandbox unreachable (test)");
  },
}));

const MARKER = "atlas_fallthrough_marker";

let testCounter = 0;
async function freshExploreModule() {
  testCounter++;
  return import(`@atlas/api/lib/tools/explore?t=fallthrough-${testCounter}`);
}

function runExplore(mod: Awaited<ReturnType<typeof freshExploreModule>>): Promise<unknown> {
  return mod.explore.execute(
    { command: `echo ${MARKER}` },
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );
}

describe("explore default-chain fall-through (#3177)", () => {
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
    // Give just-bash a real OverlayFs root so a fall-through actually runs.
    semanticRoot = mkdtempSync(join(tmpdir(), "atlas-explore-ft-"));
    writeFileSync(join(semanticRoot, "catalog.yml"), "tables: []\n");
    process.env.ATLAS_SEMANTIC_ROOT = semanticRoot;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetConfig();
    rmSync(semanticRoot, { recursive: true, force: true });
  });

  it("falls through to just-bash when the sidecar backend fails to initialize (malformed URL)", async () => {
    // No config → default chain. Sidecar is selected (ATLAS_SANDBOX_URL set)
    // but the URL is malformed, so createSidecarBackend throws at init.
    process.env.ATLAS_SANDBOX_URL = "not-a-valid-url";
    // nsjail auto-detect must report unavailable so the chain reaches just-bash.
    const fs = await import("fs");
    const spy = spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const mod = await freshExploreModule();
    const result = await runExplore(mod);

    // Fell through to just-bash and ran the command — NOT a hard failure.
    expect(typeof result).toBe("string");
    expect(result).toContain(MARKER);
    expect(result).not.toContain("Explore tool is unavailable");
    // Health reporting agrees the sidecar is down after the init failure.
    expect(mod.getExploreBackendType()).toBe("just-bash");

    spy.mockRestore();
  });

  it("falls through to just-bash when the Vercel backend fails to initialize", async () => {
    // No config → default chain. Vercel is selected (ATLAS_RUNTIME=vercel) but
    // createSandboxBackend throws (mocked above).
    process.env.ATLAS_RUNTIME = "vercel";
    const fs = await import("fs");
    const spy = spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const mod = await freshExploreModule();
    const result = await runExplore(mod);

    expect(typeof result).toBe("string");
    expect(result).toContain(MARKER);
    expect(result).not.toContain("Explore tool is unavailable");

    spy.mockRestore();
  });

  it("does NOT downgrade an explicitly-pinned single backend (SaaS deny-all) — fails closed", async () => {
    // Config-priority path with a single pinned backend and NO just-bash —
    // the SaaS posture. A Vercel init failure must fail closed, never fall
    // through to a weaker sandbox.
    _setConfigForTest({
      sandbox: { priority: ["vercel-sandbox"] },
      deployMode: "saas",
    } as unknown as ResolvedConfig);
    process.env.ATLAS_RUNTIME = "vercel"; // pass the useVercelSandbox() gate

    const mod = await freshExploreModule();
    const result = await runExplore(mod);

    expect(typeof result).toBe("string");
    // Hard failure (no insecure fallback), and the command never ran.
    expect(result).toContain("All backends in sandbox.priority");
    expect(result).toContain("vercel-sandbox");
    expect(result).not.toContain(MARKER);
  });
});
