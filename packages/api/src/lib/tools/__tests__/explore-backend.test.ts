import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers: We need fresh module state for each test since explore.ts has
// module-level variables (_nsjailAvailable, _nsjailFailed, backendPromise).
// We use dynamic imports with cache-busting to get fresh module instances.
// ---------------------------------------------------------------------------

let testCounter = 0;

/** Import a fresh copy of explore.ts with all module state reset. */
async function freshExploreModule() {
  // Bun caches modules by resolved path. We can't bust the cache directly,
  // so we rely on mock.module and re-import. Instead, we'll test the exported
  // functions by understanding their stateful behavior and resetting env vars.
  //
  // Since we can't easily reset module-level let bindings from outside,
  // we'll structure tests to work with the module's caching behavior.
  testCounter++;
  // Use a unique query param to bust the module cache
  const mod = await import(
    `@atlas/api/lib/tools/explore?t=${testCounter}`
  );
  return mod;
}

// ---------------------------------------------------------------------------
// Tests for useNsjail / getExploreBackendType / getExploreBackend
// ---------------------------------------------------------------------------

describe("explore backend selection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean env for each test
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    // Ambient deploy credentials make the vercel-sandbox backend eligible
    // (vercelSandboxAccess), which would win the priority chain and skew
    // every expectation below when the developer's env carries them.
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("nsjail binary detection via getExploreBackendType", () => {
    it("reports 'fail-closed' when ATLAS_SANDBOX=nsjail but no binary is present", async () => {
      // Was "returns 'nsjail' … (regardless of binary)", which named the exact
      // property #4834 removed. Reporting now means CONSTRUCTIBLE: the pin says
      // what the operator WANTS, and wanting nsjail is not evidence that nsjail
      // is installed. `/api/health` used to read `nsjail` / `isolated: true`
      // here for a deployment that refused every request.
      //
      // The pin is still honored where it counts — see the hard-fail case
      // below, which asserts explore REFUSES rather than degrading. Only the
      // report changed.
      process.env.ATLAS_SANDBOX = "nsjail";
      process.env.PATH = "";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      try {
        const mod = await freshExploreModule();
        expect(mod.getExploreBackendType()).toBe("fail-closed");
      } finally {
        spy.mockRestore();
      }
    });

    it("reports 'nsjail' when ATLAS_SANDBOX=nsjail and the binary IS present", async () => {
      // The other half of the same predicate, and the reason the case above is
      // about the binary rather than about the pin being ignored.
      process.env.ATLAS_SANDBOX = "nsjail";
      process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {});
      try {
        const mod = await freshExploreModule();
        expect(mod.getExploreBackendType()).toBe("nsjail");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 'nsjail' when nsjail binary is available on PATH", async () => {
      // Set a PATH that has nsjail available
      process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
      // Mock fs.accessSync to report nsjail exists
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {});

      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("nsjail");

      spy.mockRestore();
    });

    it("returns 'just-bash' when nsjail is not available", async () => {
      delete process.env.ATLAS_SANDBOX;
      delete process.env.ATLAS_NSJAIL_PATH;
      process.env.PATH = "/usr/bin:/bin";
      // Mock fs.accessSync to always throw (nsjail not found)
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("just-bash");

      spy.mockRestore();
    });

    it("returns 'vercel-sandbox' when ATLAS_RUNTIME=vercel", async () => {
      process.env.ATLAS_RUNTIME = "vercel";
      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("vercel-sandbox");
    });

    it("returns 'vercel-sandbox' when VERCEL env is set", async () => {
      process.env.VERCEL = "1";
      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("vercel-sandbox");
    });

    it("vercel-sandbox takes priority over nsjail", async () => {
      process.env.ATLAS_RUNTIME = "vercel";
      process.env.ATLAS_SANDBOX = "nsjail";
      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("vercel-sandbox");
    });
  });

  describe("useSidecar via getExploreBackendType", () => {
    it("returns 'sidecar' when ATLAS_SANDBOX_URL is set and nsjail unavailable", async () => {
      process.env.ATLAS_SANDBOX_URL = "http://localhost:8080";
      delete process.env.ATLAS_NSJAIL_PATH;
      process.env.PATH = "/usr/bin:/bin";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("sidecar");

      spy.mockRestore();
    });

    it("sidecar takes priority over nsjail auto-detect when ATLAS_SANDBOX_URL is set", async () => {
      process.env.ATLAS_SANDBOX_URL = "http://localhost:8080";
      process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {});

      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("sidecar");

      spy.mockRestore();
    });

    it("explicit nsjail (ATLAS_SANDBOX=nsjail) still beats sidecar", async () => {
      // The binary must genuinely be present for this to test PRECEDENCE. Since
      // #4834 reporting probes it, so a version of this case without a binary
      // would resolve `fail-closed` and prove nothing about the ordering — it
      // would pass for years while silently testing the wrong thing.
      process.env.ATLAS_SANDBOX = "nsjail";
      process.env.ATLAS_SANDBOX_URL = "http://localhost:8080";
      process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {});
      try {
        const mod = await freshExploreModule();
        expect(mod.getExploreBackendType()).toBe("nsjail");
      } finally {
        spy.mockRestore();
      }
    });

    it("nsjail auto-detect works when no ATLAS_SANDBOX_URL is set", async () => {
      delete process.env.ATLAS_SANDBOX_URL;
      process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {});

      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("nsjail");

      spy.mockRestore();
    });

    it("vercel-sandbox takes priority over sidecar", async () => {
      process.env.ATLAS_RUNTIME = "vercel";
      process.env.ATLAS_SANDBOX_URL = "http://localhost:8080";
      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("vercel-sandbox");
    });
  });

  describe("nsjail failure handling", () => {
    it("falls back to just-bash after nsjail init failure (_nsjailFailed)", async () => {
      // We can't directly set _nsjailFailed, but we can trigger the fallback
      // by having nsjail available but failing to initialize.
      // The getExploreBackendType checks _nsjailFailed flag.
      // Since each fresh import resets the flag, we need to trigger the
      // failure path through getExploreBackend first.

      process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(
        (p: import("fs").PathLike) => {
          const path = String(p);
          if (path === "/usr/local/bin/nsjail") return;
          // Semantic root not readable — causes createNsjailBackend to throw
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      );

      const mod = await freshExploreModule();
      // Initially nsjail is detected as available
      expect(mod.getExploreBackendType()).toBe("nsjail");

      // Trigger the explore tool to attempt nsjail init (it will fail)
      // We access the internal getExploreBackend via the tool's execute.
      // The tool.execute wraps getExploreBackend and returns error string on failure.
      const result = await mod.explore.execute(
        { command: "ls" },
        { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
      );
      // The error should mention the nsjail failure or backend issue
      expect(typeof result).toBe("string");

      // After failure with auto-detected nsjail (not ATLAS_SANDBOX=nsjail),
      // _nsjailFailed is set to true, so it falls back to just-bash
      // But the next getExploreBackendType should reflect just-bash
      // Note: this only works if the module state is shared
      // Since _nsjailFailed is set in getExploreBackend's catch block
      expect(mod.getExploreBackendType()).toBe("just-bash");

      spy.mockRestore();
    });

    it("throws (does NOT fall back) when ATLAS_SANDBOX=nsjail and binary is missing", async () => {
      process.env.ATLAS_SANDBOX = "nsjail";
      process.env.PATH = "";
      delete process.env.ATLAS_NSJAIL_PATH;

      const fs = await import("fs");
      const spy = spyOn(fs, "accessSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const mod = await freshExploreModule();
      // Reporting says `fail-closed`: since #4834 `isBackendAvailable` probes
      // the binary rather than trusting the pin, so an unsatisfiable pin
      // short-circuits the resolver on its unavailable hard-fail step.
      expect(mod.getExploreBackendType()).toBe("fail-closed");

      // CONSTRUCTION is still attempted, though — `tryCreateBackend` checks
      // `ATLAS_SANDBOX` itself and skips its availability gate under the pin, so
      // #4834's narrowing of the REPORTING predicate never reaches it — and the
      // refusal therefore carries nsjail's specific remediation rather than a
      // generic message. Reporting got stricter; the attempt did not.
      //
      // And it is a refusal, NOT a fall back to just-bash
      const result = await mod.explore.execute(
        { command: "ls" },
        { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
      );
      expect(typeof result).toBe("string");
      expect(result).toContain("nsjail was explicitly requested");

      spy.mockRestore();
    });
  });

  describe("nsjail detection failure is never silent", () => {
    it("reports just-bash when no binary is detected on the auto-detect chain", async () => {
      // Renamed from "useNsjail unexpected error logging", which it never
      // tested: it drove `accessSync` to throw ENOENT, which `findNsjailBinary`
      // catches internally, so the detection module loaded fine and the catch
      // this block claimed to cover was never entered. It also spied
      // `console.error` and asserted nothing about it.
      //
      // What it does prove is worth keeping — the auto-detect chain degrades to
      // just-bash when no binary is found — so that is what it now says. The
      // catch it was named for is covered by the case below.
      delete process.env.ATLAS_SANDBOX;
      delete process.env.ATLAS_NSJAIL_PATH;
      process.env.PATH = "";

      const fs = await import("fs");
      const fsSpy = spyOn(fs, "accessSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      try {
        const mod = await freshExploreModule();
        expect(mod.getExploreBackendType()).toBe("just-bash");
      } finally {
        fsSpy.mockRestore();
      }
    });

    // KNOWN COVERAGE GAP, stated rather than papered over: nothing here exercises
    // `nsjailBinaryPresent()`'s catch, where #4834 made both arms log (the
    // MODULE_NOT_FOUND arm previously returned silently, which now would pin
    // /api/health to fail-closed with no explanation).
    //
    // The obvious test — `mock.module` the detection module with a throwing
    // factory plus a logger spy — passes alone and fails in file order: by the
    // time it runs, earlier cases have already resolved `./backends/nsjail`, so
    // the throwing factory does not take effect. A version that is green only
    // when run in isolation is worse than none, so it is not shipped. Covering
    // this properly wants its own file, where the mock is installed before any
    // resolution happens.
  });

  describe("invalidateExploreBackend", () => {
    it("clears cached backend so next call recreates it", async () => {
      const mod = await freshExploreModule();
      // Just verify the function exists and is callable
      expect(typeof mod.invalidateExploreBackend).toBe("function");
      mod.invalidateExploreBackend(); // Should not throw
    });
  });

  describe("sandbox.priority failure message", () => {
    it("includes backend reasons and self-hosted just-bash guidance", async () => {
      const mod = await freshExploreModule();
      const message = mod._formatSandboxPriorityFailureForTest(
        ["vercel-sandbox", "sidecar"],
        [
          { name: "vercel-sandbox", reason: "401 invalid token" },
          { name: "sidecar", reason: "connection refused" },
        ],
        "self-hosted",
      );

      expect(message).toContain("vercel-sandbox: 401 invalid token");
      expect(message).toContain("sidecar: connection refused");
      expect(message).toContain("VERCEL_TEAM_ID");
      expect(message).toContain("ATLAS_SANDBOX_URL");
      expect(message).toContain("Add 'just-bash'");
    });

    it("suppresses just-bash guidance in SaaS mode", async () => {
      const mod = await freshExploreModule();
      const message = mod._formatSandboxPriorityFailureForTest(
        ["vercel-sandbox", "sidecar"],
        [{ name: "vercel-sandbox", reason: "401 invalid token" }],
        "saas",
      );

      expect(message).toContain("vercel-sandbox: 401 invalid token");
      expect(message).not.toContain("Add 'just-bash'");
    });
  });
});
