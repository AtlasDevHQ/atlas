import { describe, expect, it, afterEach } from "bun:test";
import { mock } from "bun:test";

// Mock logger, tracing, and config
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
}));

let mockConfig: unknown = null;
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
}));

const {
  validatePythonCode,
  getEffectiveBlockedModules,
  DEFAULT_BLOCKED_MODULES,
  CRITICAL_MODULES,
} = await import("@atlas/api/lib/tools/python");

// ---------------------------------------------------------------------------
// Configurable blocked imports
// ---------------------------------------------------------------------------

describe("configurable blocked imports", () => {
  afterEach(() => {
    mockConfig = null;
  });

  describe("getEffectiveBlockedModules", () => {
    it("returns default blocked modules when no config", () => {
      mockConfig = null;
      const result = getEffectiveBlockedModules();
      expect(result).toEqual(DEFAULT_BLOCKED_MODULES);
    });

    it("returns default blocked modules when config has no python section", () => {
      mockConfig = { source: "file" };
      const result = getEffectiveBlockedModules();
      expect(result).toEqual(DEFAULT_BLOCKED_MODULES);
    });

    it("adds extra blocked modules from config", () => {
      mockConfig = {
        python: { blockedModules: ["boto3", "fabric"], allowModules: [] },
      };
      const result = getEffectiveBlockedModules();
      expect(result.has("boto3")).toBe(true);
      expect(result.has("fabric")).toBe(true);
      // Default modules still blocked
      expect(result.has("subprocess")).toBe(true);
      expect(result.has("os")).toBe(true);
    });

    it("removes allowed modules from the default blocked list", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["requests", "httpx"] },
      };
      const result = getEffectiveBlockedModules();
      expect(result.has("requests")).toBe(false);
      expect(result.has("httpx")).toBe(false);
      // Other defaults still blocked
      expect(result.has("subprocess")).toBe(true);
      expect(result.has("pickle")).toBe(true);
    });

    it("handles both blocked and allowed together", () => {
      mockConfig = {
        python: {
          blockedModules: ["boto3"],
          allowModules: ["requests"],
        },
      };
      const result = getEffectiveBlockedModules();
      expect(result.has("boto3")).toBe(true);
      expect(result.has("requests")).toBe(false);
      expect(result.has("subprocess")).toBe(true);
    });

    it("throws when trying to unblock critical module: os", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["os"] },
      };
      expect(() => getEffectiveBlockedModules()).toThrow("Cannot unblock critical Python modules: os");
    });

    it("throws when trying to unblock critical module: subprocess", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["subprocess"] },
      };
      expect(() => getEffectiveBlockedModules()).toThrow("Cannot unblock critical Python modules: subprocess");
    });

    it("throws when trying to unblock critical module: sys", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["sys"] },
      };
      expect(() => getEffectiveBlockedModules()).toThrow("Cannot unblock critical Python modules: sys");
    });

    it("throws when trying to unblock critical module: shutil", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["shutil"] },
      };
      expect(() => getEffectiveBlockedModules()).toThrow("Cannot unblock critical Python modules: shutil");
    });

    it("throws listing all critical violations at once", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["os", "subprocess", "requests"] },
      };
      expect(() => getEffectiveBlockedModules()).toThrow("os, subprocess");
    });

    it("returns default set when both arrays are empty", () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: [] },
      };
      const result = getEffectiveBlockedModules();
      expect(result).toEqual(DEFAULT_BLOCKED_MODULES);
    });

    it("blockedModules takes precedence when module is in both lists", () => {
      mockConfig = {
        python: {
          blockedModules: ["requests"],
          allowModules: ["requests"],
        },
      };
      const result = getEffectiveBlockedModules();
      expect(result.has("requests")).toBe(true);
    });

    it("deduplicates blockedModules entries", () => {
      mockConfig = {
        python: { blockedModules: ["boto3", "boto3"], allowModules: [] },
      };
      const result = getEffectiveBlockedModules();
      expect(result.has("boto3")).toBe(true);
      // Set naturally deduplicates, just verify size is correct
      expect(result.size).toBe(DEFAULT_BLOCKED_MODULES.size + 1);
    });
  });

  describe("validatePythonCode with config", () => {
    it("blocks newly added module from config", async () => {
      mockConfig = {
        python: { blockedModules: ["boto3"], allowModules: [] },
      };
      const result = await validatePythonCode("import boto3");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("boto3");
    });

    it("allows module removed from blocked list via config", async () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["requests"] },
      };
      const result = await validatePythonCode("import requests");
      expect(result.safe).toBe(true);
    });

    it("still blocks default modules when no config override", async () => {
      mockConfig = null;
      const result = await validatePythonCode("import subprocess");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("subprocess");
    });

    it("returns error when config tries to allow critical module", async () => {
      mockConfig = {
        python: { blockedModules: [], allowModules: ["os"] },
      };
      const result = await validatePythonCode("import os");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("Cannot unblock critical");
    });
  });

  describe("constants", () => {
    it("DEFAULT_BLOCKED_MODULES contains the expected default modules", () => {
      expect(DEFAULT_BLOCKED_MODULES.size).toBe(25);
    });

    it("CRITICAL_MODULES contains os, subprocess, sys, shutil", () => {
      expect(CRITICAL_MODULES).toEqual(new Set(["os", "subprocess", "sys", "shutil"]));
    });

    it("all critical modules are in the default blocked list", () => {
      for (const mod of CRITICAL_MODULES) {
        expect(DEFAULT_BLOCKED_MODULES.has(mod)).toBe(true);
      }
    });
  });
});
