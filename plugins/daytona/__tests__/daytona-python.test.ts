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
const networkCalls: Record<string, unknown>[] = [];
/**
 * Ordering matters more than either call on its own: the bound has to land
 * after `pip install` (Daytona drops its essential-services lists once a custom
 * allow list is set) and before any agent code runs. One timeline is the only
 * way to assert both halves of that at once.
 */
const timeline: string[] = [];
let deleted = 0;
let execImpl: (command: string) => Promise<{ result?: string; exitCode?: number }> =
  async () => ({ result: "", exitCode: 0 });
let updateNetworkImpl: (settings: Record<string, unknown>) => Promise<void> = async () => {};
let omitUpdateNetworkSettings = false;

const sandboxStub = {
  process: {
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSec?: number,
    ) => {
      execCalls.push({ command, cwd, env, timeoutSec });
      timeline.push(command.startsWith("'pip'") ? "pip" : `exec:${command.slice(0, 9)}`);
      return execImpl(command);
    },
  },
  updateNetworkSettings: async (settings: Record<string, unknown>) => {
    networkCalls.push(settings);
    timeline.push("network");
    await updateNetworkImpl(settings);
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
      if (omitUpdateNetworkSettings) {
        const { updateNetworkSettings: _omitted, ...rest } = sandboxStub;
        return rest;
      }
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
  networkCalls.length = 0;
  timeline.length = 0;
  deleted = 0;
  execImpl = async () => ({ result: "", exitCode: 0 });
  updateNetworkImpl = async () => {};
  omitUpdateNetworkSettings = false;
});

describe("daytona sandbox plugin — Python surface", () => {
  test("declares createPython and an honest egress posture", () => {
    // "enforced" since the issue-4666 re-verify: @daytonaio/sdk 0.201.0 does
    // expose per-sandbox egress control, which #5500 predated.
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    expect(typeof plugin.sandbox.createPython).toBe("function");
    expect(plugin.sandbox.pythonEgressControl).toBe("enforced");
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

  // -------------------------------------------------------------------------
  // Egress enforcement (issue 4666 re-verify of #5500's "unsupported")
  // -------------------------------------------------------------------------

  test("blocks all egress when the host asks for deny-all", async () => {
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );
    await backend.exec("print(1)");

    // The three settings are mutually exclusive — exactly one is sent.
    expect(networkCalls).toEqual([{ networkBlockAll: true }]);
  });

  test("narrows to the host's datasource hosts on an allowlist", async () => {
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "allowlist", hosts: ["crm.example.com", "api.example.com"] } }),
    );
    await backend.exec("print(1)");

    expect(networkCalls).toEqual([{ domainAllowList: "crm.example.com,api.example.com" }]);
  });

  test("locks down AFTER pip install and BEFORE any agent code runs", async () => {
    // Narrowing first would cut the sandbox off from PyPI: Daytona's
    // pre-approved essential-services lists stop applying the moment a custom
    // allow list is set. Narrowing last would run the agent's code unbounded.
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin({ ...CONFIG, pythonPackages: ["pandas"] });
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );
    await backend.exec("print(1)");

    expect(timeline.indexOf("pip")).toBeLessThan(timeline.indexOf("network"));
    expect(timeline.indexOf("network")).toBeLessThan(timeline.indexOf("exec:'python3'"));
  });

  test("leaves a fresh sandbox alone when the host asks for allow-all", async () => {
    // A per-request sandbox already starts unrestricted, so there is nothing to
    // relax — and calling anyway would invent a Tier 3/4 failure mode for a
    // policy that bounds nothing.
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "allow-all" } }),
    );
    await backend.exec("print(1)");

    expect(networkCalls).toEqual([]);
  });

  test("an empty allowlist is deny-all, never allow-all", async () => {
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "allowlist", hosts: [] } }),
    );
    await backend.exec("print(1)");

    expect(networkCalls).toEqual([{ networkBlockAll: true }]);
  });

  test("fails the run closed when Daytona rejects the policy (Tier 1/2 org)", async () => {
    // The whole point of declaring "enforced": a refused bound must not become
    // a Python run that ships query rows out of an unbounded sandbox.
    respondWithResult({ success: true });
    updateNetworkImpl = async () => {
      throw new Error("403 Forbidden: network policy overrides require Tier 3");
    };
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("Tier 3");
    expect(result.success === false && result.error).toContain(
      "refusing to run Python with an unenforced network bound",
    );
    // No agent code ran, and the sandbox it would have run in is gone.
    expect(execCalls.some((c) => c.command.startsWith("'python3'"))).toBe(false);
    expect(deleted).toBe(1);
  });

  test("fails closed on an @daytonaio/sdk too old to expose updateNetworkSettings", async () => {
    omitUpdateNetworkSettings = true;
    respondWithResult({ success: true });
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("upgrade @daytonaio/sdk");
    expect(execCalls.some((c) => c.command.startsWith("'python3'"))).toBe(false);
  });

  test("rejects an allowlist past Daytona's 20-domain cap rather than truncating it", async () => {
    // Silently dropping host 21 would hand the agent a sandbox that cannot
    // reach a datasource the host said it could, diagnosable only as a timeout
    // inside Python.
    respondWithResult({ success: true });
    const hosts = Array.from({ length: 21 }, (_, i) => `host${i}.example.com`);
    const plugin = buildDaytonaSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "allowlist", hosts } }),
    );

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("at most 20 allowed domains");
    expect(networkCalls).toEqual([]);
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
