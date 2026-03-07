import { describe, expect, it, mock, afterEach } from "bun:test";

// Mock logger and tracing to avoid side effects
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

const { validatePythonCode } = await import(
  "@atlas/api/lib/tools/python"
);

// ---------------------------------------------------------------------------
// Import guard tests
// ---------------------------------------------------------------------------

describe("validatePythonCode", () => {
  describe("blocked imports", () => {
    it("rejects import subprocess", async () => {
      const result = await validatePythonCode("import subprocess");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("subprocess");
    });

    it("rejects from os import path", async () => {
      const result = await validatePythonCode("from os import path");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("os");
    });

    it("rejects import socket", async () => {
      const result = await validatePythonCode("import socket");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("socket");
    });

    it("rejects import shutil", async () => {
      const result = await validatePythonCode("import shutil");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("shutil");
    });

    it("rejects import sys", async () => {
      const result = await validatePythonCode("import sys");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("sys");
    });

    it("rejects import ctypes", async () => {
      const result = await validatePythonCode("import ctypes");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("ctypes");
    });

    it("rejects import importlib", async () => {
      const result = await validatePythonCode("import importlib");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("importlib");
    });

    it("rejects import code", async () => {
      const result = await validatePythonCode("import code");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("code");
    });

    it("rejects import signal", async () => {
      const result = await validatePythonCode("import signal");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("signal");
    });

    it("rejects import multiprocessing", async () => {
      const result = await validatePythonCode("import multiprocessing");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("multiprocessing");
    });

    it("rejects from subprocess import run", async () => {
      const result = await validatePythonCode("from subprocess import run");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("subprocess");
    });

    it("rejects os as submodule (import os.path)", async () => {
      const result = await validatePythonCode("import os.path");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("os");
    });

    // Network modules (added per PR review #5)
    it("rejects import http", async () => {
      const result = await validatePythonCode("import http");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("http");
    });

    it("rejects import urllib", async () => {
      const result = await validatePythonCode("import urllib");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("urllib");
    });

    it("rejects import requests", async () => {
      const result = await validatePythonCode("import requests");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("requests");
    });

    it("rejects import pickle", async () => {
      const result = await validatePythonCode("import pickle");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("pickle");
    });

    it("rejects import tempfile", async () => {
      const result = await validatePythonCode("import tempfile");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("tempfile");
    });

    it("rejects import pathlib", async () => {
      const result = await validatePythonCode("import pathlib");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("pathlib");
    });
  });

  describe("blocked builtins", () => {
    it("rejects exec()", async () => {
      const result = await validatePythonCode('exec("print(1)")');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("exec");
    });

    it("rejects eval()", async () => {
      const result = await validatePythonCode('eval("1+1")');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("eval");
    });

    it("rejects compile()", async () => {
      const result = await validatePythonCode('compile("x=1", "<string>", "exec")');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("compile");
    });

    it("rejects __import__()", async () => {
      const result = await validatePythonCode('__import__("os")');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("__import__");
    });

    it("rejects open()", async () => {
      const result = await validatePythonCode('open("/etc/passwd")');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("open");
    });

    it("rejects breakpoint()", async () => {
      const result = await validatePythonCode("breakpoint()");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("breakpoint");
    });

    // Guard bypass mitigations (PR review #1)
    it("rejects getattr()", async () => {
      const result = await validatePythonCode('getattr(__builtins__, "exec")("print(1)")');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("getattr");
    });

    it("rejects globals()", async () => {
      const result = await validatePythonCode('globals()["__builtins__"]');
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("globals");
    });

    it("rejects vars()", async () => {
      const result = await validatePythonCode("vars()");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("vars");
    });
  });

  describe("allowed imports", () => {
    it("allows pandas", async () => {
      const result = await validatePythonCode("import pandas as pd");
      expect(result.safe).toBe(true);
    });

    it("allows numpy", async () => {
      const result = await validatePythonCode("import numpy as np");
      expect(result.safe).toBe(true);
    });

    it("allows matplotlib", async () => {
      const result = await validatePythonCode("import matplotlib.pyplot as plt");
      expect(result.safe).toBe(true);
    });

    it("allows json", async () => {
      const result = await validatePythonCode("import json");
      expect(result.safe).toBe(true);
    });

    it("allows math", async () => {
      const result = await validatePythonCode("import math");
      expect(result.safe).toBe(true);
    });

    it("allows datetime", async () => {
      const result = await validatePythonCode("from datetime import datetime");
      expect(result.safe).toBe(true);
    });

    it("allows statistics", async () => {
      const result = await validatePythonCode("import statistics");
      expect(result.safe).toBe(true);
    });

    it("allows collections", async () => {
      const result = await validatePythonCode("from collections import Counter");
      expect(result.safe).toBe(true);
    });
  });

  describe("syntax errors", () => {
    it("rejects code with syntax errors", async () => {
      const result = await validatePythonCode("def foo(");
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("SyntaxError");
    });
  });

  describe("complex code", () => {
    it("allows legitimate data analysis code", async () => {
      const code = `
import json
import math
from collections import Counter

values = [1, 2, 3, 4, 5]
mean = sum(values) / len(values)
print(f"Mean: {mean}")
`;
      const result = await validatePythonCode(code);
      expect(result.safe).toBe(true);
    });

    it("rejects code with blocked import buried in logic", async () => {
      const code = `
x = 1
y = 2
import subprocess
z = x + y
`;
      const result = await validatePythonCode(code);
      expect(result.safe).toBe(false);
      if (!result.safe) expect(result.reason).toContain("subprocess");
    });
  });
});

// ---------------------------------------------------------------------------
// Sidecar routing tests
// ---------------------------------------------------------------------------

describe("executePython tool", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function saveAndSetEnv(key: string, value: string | undefined) {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(savedEnv)) {
      delete savedEnv[key];
    }
  });

  it("rejects execution when ATLAS_SANDBOX_URL is not set", async () => {
    saveAndSetEnv("ATLAS_SANDBOX_URL", undefined);

    const { executePython } = await import("@atlas/api/lib/tools/python");
    const execute = executePython.execute!;
    const result = await execute(
      { code: 'print("hello")', explanation: "test", data: undefined },
      {} as never,
    ) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("ATLAS_SANDBOX_URL");
  });

  it("rejects code that fails import guard before hitting sidecar", async () => {
    saveAndSetEnv("ATLAS_SANDBOX_URL", "http://localhost:9999");

    const { executePython } = await import("@atlas/api/lib/tools/python");
    const execute = executePython.execute!;
    const result = await execute(
      { code: "import subprocess", explanation: "test", data: undefined },
      {} as never,
    ) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("subprocess");
  });
});

// Registry gating (ATLAS_PYTHON_ENABLED + ATLAS_SANDBOX_URL) is tested in registry.test.ts
