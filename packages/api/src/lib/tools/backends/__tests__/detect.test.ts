import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let _warnCalls = 0;

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {
      _warnCalls += 1;
    },
    error: () => {},
  }),
}));

let mockConfig: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

const SANDBOX_ENV = [
  "ATLAS_RUNTIME",
  "VERCEL",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
] as const;

async function detectModule() {
  const mod = await import("@atlas/api/lib/tools/backends/detect");
  mod._resetVercelSandboxDetectForTest();
  return mod;
}

describe("Vercel sandbox detection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _warnCalls = 0;
    mockConfig = null;
    for (const key of SANDBOX_ENV) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("vercelSandboxAccess", () => {
    it.each([
      ["VERCEL_TEAM_ID"],
      ["VERCEL_PROJECT_ID"],
      ["VERCEL_TOKEN"],
    ] as const)("returns undefined when %s is missing", async (missing) => {
      process.env.VERCEL_TEAM_ID = "team_123";
      process.env.VERCEL_PROJECT_ID = "prj_123";
      process.env.VERCEL_TOKEN = "vercel-token";
      delete process.env[missing];

      const { vercelSandboxAccess } = await detectModule();

      expect(vercelSandboxAccess()).toBeUndefined();
    });

    it("returns explicit access with a redacted reveal-only token when all credentials are set", async () => {
      process.env.VERCEL_TEAM_ID = "team_123";
      process.env.VERCEL_PROJECT_ID = "prj_123";
      process.env.VERCEL_TOKEN = "vercel-token";

      const { vercelSandboxAccess } = await detectModule();

      const access = vercelSandboxAccess();
      expect(access?.teamId).toBe("team_123");
      expect(access?.projectId).toBe("prj_123");
      expect(access?.token.reveal()).toBe("vercel-token");
      expect(String(access?.token)).toBe("[REDACTED]");
      expect(JSON.stringify(access)).not.toContain("vercel-token");
    });

    it("sources team + project IDs from atlas.config.ts when the env vars are unset (#3706)", async () => {
      // Only the token is env; the non-secret IDs come from config.
      process.env.VERCEL_TOKEN = "vercel-token";
      mockConfig = {
        sandbox: { vercel: { teamId: "team_cfg", projectId: "prj_cfg" } },
      };

      const { vercelSandboxAccess } = await detectModule();

      const access = vercelSandboxAccess();
      expect(access?.teamId).toBe("team_cfg");
      expect(access?.projectId).toBe("prj_cfg");
      expect(access?.token.reveal()).toBe("vercel-token");
    });

    it("lets the env vars override the config IDs", async () => {
      process.env.VERCEL_TEAM_ID = "team_env";
      process.env.VERCEL_PROJECT_ID = "prj_env";
      process.env.VERCEL_TOKEN = "vercel-token";
      mockConfig = {
        sandbox: { vercel: { teamId: "team_cfg", projectId: "prj_cfg" } },
      };

      const { vercelSandboxAccess } = await detectModule();

      const access = vercelSandboxAccess();
      expect(access?.teamId).toBe("team_env");
      expect(access?.projectId).toBe("prj_env");
    });

    it("returns undefined when config supplies IDs but the token (env-only) is missing", async () => {
      mockConfig = {
        sandbox: { vercel: { teamId: "team_cfg", projectId: "prj_cfg" } },
      };

      const { vercelSandboxAccess } = await detectModule();

      expect(vercelSandboxAccess()).toBeUndefined();
    });

    it("records the partial-credentials warning only once", async () => {
      process.env.VERCEL_TEAM_ID = "team_123";
      process.env.VERCEL_TOKEN = "vercel-token";

      const { _partialCredsWarnedForTest, vercelSandboxAccess } = await detectModule();

      expect(_partialCredsWarnedForTest()).toBe(false);
      expect(vercelSandboxAccess()).toBeUndefined();
      expect(_partialCredsWarnedForTest()).toBe(true);
      expect(vercelSandboxAccess()).toBeUndefined();
      expect(_partialCredsWarnedForTest()).toBe(true);
    });
  });

  describe("useVercelSandbox", () => {
    it("returns true on ATLAS_RUNTIME=vercel", async () => {
      process.env.ATLAS_RUNTIME = "vercel";
      const { useVercelSandbox } = await detectModule();
      expect(useVercelSandbox()).toBe(true);
    });

    it("returns true on VERCEL=1", async () => {
      process.env.VERCEL = "1";
      const { useVercelSandbox } = await detectModule();
      expect(useVercelSandbox()).toBe(true);
    });

    it("returns true when all explicit credentials are set without platform env", async () => {
      process.env.VERCEL_TEAM_ID = "team_123";
      process.env.VERCEL_PROJECT_ID = "prj_123";
      process.env.VERCEL_TOKEN = "vercel-token";

      const { useVercelSandbox } = await detectModule();

      expect(useVercelSandbox()).toBe(true);
    });

    it("returns false when two explicit credentials are set without platform env", async () => {
      process.env.VERCEL_TEAM_ID = "team_123";
      process.env.VERCEL_TOKEN = "vercel-token";

      const { useVercelSandbox } = await detectModule();

      expect(useVercelSandbox()).toBe(false);
    });

    it("returns false on empty env", async () => {
      const { useVercelSandbox } = await detectModule();
      expect(useVercelSandbox()).toBe(false);
    });
  });
});
