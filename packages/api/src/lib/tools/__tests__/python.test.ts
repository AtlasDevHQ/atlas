import { describe, expect, it, beforeEach, mock } from "bun:test";

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

const { validatePythonCode, executePythonCode } = await import(
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
// Execution tests (real Python — requires python3)
// ---------------------------------------------------------------------------

describe("executePythonCode", () => {
  it("executes simple print", async () => {
    const result = await executePythonCode('print("hello world")');
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello world");
  });

  it("captures runtime errors", async () => {
    const result = await executePythonCode("1 / 0");
    expect(result.success).toBe(false);
    expect(result.error).toContain("ZeroDivisionError");
  });

  it("receives data payload", async () => {
    const code = `
if data:
    print(f"columns: {data['columns']}")
    print(f"rows: {len(data['rows'])}")
`;
    const result = await executePythonCode(code, {
      columns: ["id", "name"],
      rows: [[1, "Alice"], [2, "Bob"]],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("columns: ['id', 'name']");
    expect(result.output).toContain("rows: 2");
  });

  it("returns table result via _atlas_table", async () => {
    const code = `
_atlas_table = {"columns": ["x", "y"], "rows": [[1, 2], [3, 4]]}
`;
    const result = await executePythonCode(code);
    expect(result.success).toBe(true);
    expect(result.table).toEqual({
      columns: ["x", "y"],
      rows: [[1, 2], [3, 4]],
    });
  });

  it("handles empty code output", async () => {
    const result = await executePythonCode("x = 1 + 1");
    expect(result.success).toBe(true);
  });

  it("handles multi-line output", async () => {
    const code = `
for i in range(3):
    print(f"line {i}")
`;
    const result = await executePythonCode(code);
    expect(result.success).toBe(true);
    expect(result.output).toContain("line 0");
    expect(result.output).toContain("line 2");
  });

  it("runs without data when none provided", async () => {
    const code = `
print(f"data is {data}")
print(f"df is {df}")
`;
    const result = await executePythonCode(code);
    expect(result.success).toBe(true);
    expect(result.output).toContain("data is None");
    expect(result.output).toContain("df is None");
  });
});
