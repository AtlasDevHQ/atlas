/**
 * Tests for the Daytona plugin's Python surface (#4665).
 *
 * Separate from daytona-sandbox.test.ts for the same reason as E2B's: the
 * Python path needs a richer `fs` mock than the explore path, and bun's
 * per-file isolation keeps the two from fighting over the module registry.
 *
 * The transport protocol is covered in the SDK (python-backend.test.ts); what
 * is under test here is the mapping onto Daytona's API — including the two
 * places it differs from E2B's, merged output streams and region placement.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @daytonaio/sdk — must come before importing the plugin
// ---------------------------------------------------------------------------

const files = new Map<string, Uint8Array>();
const execCalls: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}[] = [];
const createParams: unknown[] = [];
let deleted = 0;
let execImpl: (command: string) => Promise<{ result?: string; exitCode?: number }> =
  async () => ({ result: "", exitCode: 0 });

const sandboxStub = {
  process: {
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSec?: number,
    ) => {
      execCalls.push({ command, cwd, env, timeoutSec });
      return execImpl(command);
    },
  },
  fs: {
    createFolder: async (_path: string, _mode: string) => {},
    uploadFile: async (content: Uint8Array, path: string) => {
      files.set(path, content);
    },
    downloadFile: async (path: string) => {
      const found = files.get(path);
      if (!found) throw new Error(`404 not found: ${path}`);
      return found;
    },
    listFiles: async (path: string) => {
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => ({ name: p.slice(prefix.length) }));
    },
  },
};

const FakeDaytona = mock(function () {
  return {
    create: async (params?: unknown) => {
      createParams.push(params);
      return sandboxStub;
    },
    delete: async () => {
      deleted++;
    },
  };
});

void mock.module("@daytonaio/sdk", () => ({ Daytona: FakeDaytona }));
// Dual-package hazard (#3409), same as daytona-sandbox.test.ts: the SDK's
// exports map sends `import` to esm/ and `require` to cjs/, and the plugin
// loads it with require(). Without this second registration the bare mock is
// bypassed and these tests become live Daytona API calls.
try {
  void mock.module(require.resolve("@daytonaio/sdk"), () => ({
    Daytona: FakeDaytona,
  }));
} catch {
  // intentionally ignored: SDK not installed — the bare-specifier mock above
  // covers both loaders as a virtual module.
}

// Import AFTER the mocks are in place.
const { buildDaytonaSandboxPlugin } = await import("../src/index");
import type { PluginPythonOptions } from "@useatlas/plugin-sdk";

const CONFIG = {
  apiKey: "dt_test_key",
  timeoutSec: 30,
  pythonPackages: [] as string[],
};

function options(overrides: Partial<PluginPythonOptions> = {}): PluginPythonOptions {
  return {
    wrapperSource: "# wrapper\n",
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  };
}

function respondWithResult(result: unknown): void {
  execImpl = async (command: string) => {
    const execDir = /'([^']*)\/wrapper\.py'/.exec(command)?.[1];
    if (execDir) {
      files.set(
        `${execDir}/result.json`,
        new TextEncoder().encode(JSON.stringify(result)),
      );
    }
    return { result: "", exitCode: 0 };
  };
}

beforeEach(() => {
  files.clear();
  execCalls.length = 0;
  createParams.length = 0;
  deleted = 0;
  execImpl = async () => ({ result: "", exitCode: 0 });
});

describe("daytona sandbox plugin — Python surface", () => {
  test("declares createPython and an honest egress posture", () => {
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    expect(typeof plugin.sandbox.createPython).toBe("function");
    expect(plugin.sandbox.pythonEgressControl).toBe("unsupported");
  });

  test("round-trips code and data through the org's own Daytona sandbox", async () => {
    respondWithResult({ success: true, output: "42" });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("print(42)", { columns: ["n"], rows: [[42]] });

    expect(result).toEqual({ success: true, output: "42" });
    const pythonRun = execCalls.find((c) => c.command.startsWith("'python3'"))!;
    expect(pythonRun.command).toContain("wrapper.py");
    expect(pythonRun.command).toContain("data.json");
    expect(pythonRun.env?.ATLAS_RESULT_FILE).toContain("result.json");
    // Daytona's timeout is in seconds; the host's ms budget converts, not
    // silently truncates to the plugin's own 30s default.
    expect(pythonRun.timeoutSec).toBe(30);
  });

  test("places Python sandboxes in the configured region target", async () => {
    // The field that makes a Daytona connection a residency answer rather than
    // only an isolation one. Explore and Python must land in the same place.
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin({ ...CONFIG, target: "eu" });
    const backend = await plugin.sandbox.createPython!(options());
    await backend.exec("print(1)");

    expect(createParams).toEqual([{ target: "eu" }]);
  });

  test("omits the target entirely when none is configured", async () => {
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());
    await backend.exec("print(1)");

    expect(createParams).toEqual([{}]);
  });

  test("routes Daytona's merged output to stderr on a failing exit code", async () => {
    // Daytona combines stdout and stderr into `result`. Reporting it as stdout
    // would lose the only diagnosis available when the wrapper never wrote a
    // result file.
    execImpl = async () => ({ result: "Traceback: boom", exitCode: 1 });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("print(x)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe("Traceback: boom");
  });

  test("reads chart PNGs back off the sandbox filesystem", async () => {
    execImpl = async (command: string) => {
      const execDir = /'([^']*)\/wrapper\.py'/.exec(command)![1]!;
      files.set(
        `${execDir}/result.json`,
        new TextEncoder().encode(JSON.stringify({ success: true })),
      );
      files.set(`${execDir}/charts/chart_0.png`, new Uint8Array([3, 4]));
      return { result: "", exitCode: 0 };
    };
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("chart_path()");

    expect(result.success && result.charts).toEqual([
      { base64: Buffer.from([3, 4]).toString("base64"), mimeType: "image/png" },
    ]);
  });

  test("close deletes the sandbox", async () => {
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());
    await backend.exec("print(1)");

    await backend.close!();

    expect(deleted).toBe(1);
  });
});
