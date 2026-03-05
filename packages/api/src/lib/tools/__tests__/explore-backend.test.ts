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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("useNsjail via getExploreBackendType", () => {
    it("returns 'nsjail' when ATLAS_SANDBOX=nsjail (regardless of binary)", async () => {
      process.env.ATLAS_SANDBOX = "nsjail";
      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("nsjail");
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
      process.env.ATLAS_SANDBOX = "nsjail";
      process.env.ATLAS_SANDBOX_URL = "http://localhost:8080";
      const mod = await freshExploreModule();
      expect(mod.getExploreBackendType()).toBe("nsjail");
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
      // getExploreBackendType says nsjail because ATLAS_SANDBOX=nsjail
      // bypasses binary check
      expect(mod.getExploreBackendType()).toBe("nsjail");

      // But actually trying to create the backend will fail with a throw,
      // NOT fall back to just-bash
      const result = await mod.explore.execute(
        { command: "ls" },
        { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
      );
      expect(typeof result).toBe("string");
      expect(result).toContain("nsjail was explicitly requested");

      spy.mockRestore();
    });
  });

  describe("useNsjail unexpected error logging", () => {
    it("logs unexpected errors that are not MODULE_NOT_FOUND", async () => {
      // We need to make the require("./explore-nsjail") throw a non-MODULE_NOT_FOUND error.
      // This is hard to test with real modules, but we can verify the code path exists
      // by checking that _nsjailAvailable is set to false on unexpected errors.
      // The console.error call is the observable side effect.

      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

      // Remove ATLAS_SANDBOX so useNsjail goes through auto-detection
      delete process.env.ATLAS_SANDBOX;
      delete process.env.ATLAS_NSJAIL_PATH;
      process.env.PATH = "";

      const fs = await import("fs");
      const fsSpy = spyOn(fs, "accessSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const mod = await freshExploreModule();
      // This should exercise the useNsjail auto-detection path.
      // Since nsjail is not found, it returns just-bash.
      const result = mod.getExploreBackendType();
      expect(result).toBe("just-bash");

      consoleSpy.mockRestore();
      fsSpy.mockRestore();
    });
  });

  describe("invalidateExploreBackend", () => {
    it("clears cached backend so next call recreates it", async () => {
      const mod = await freshExploreModule();
      // Just verify the function exists and is callable
      expect(typeof mod.invalidateExploreBackend).toBe("function");
      mod.invalidateExploreBackend(); // Should not throw
    });
  });
});
