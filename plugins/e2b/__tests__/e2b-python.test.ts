/**
 * Tests for the E2B plugin's Python surface (#4665).
 *
 * A separate file from e2b-sandbox.test.ts on purpose: the Python path needs a
 * richer `files` mock (makeDir / read / list) than the explore path, and bun's
 * per-file isolation keeps the two mocks from fighting over the same module.
 *
 * The transport protocol itself is covered in the SDK
 * (python-backend.test.ts); what is under test here is the mapping onto E2B's
 * API — the part that would silently break on an SDK method rename.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock e2b SDK — must come before importing the plugin
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
}

const fsState: FakeFs = { files: new Map(), dirs: new Set() };
const runCalls: { command: string; options: Record<string, unknown> }[] = [];
let runImpl: (command: string) => Promise<unknown> = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});
let killed = 0;
let created = 0;
const networkCalls: Record<string, unknown>[] = [];
/**
 * Ordering matters more than either call on its own: the bound has to land
 * after `pip install` (a narrowed sandbox cannot reach PyPI) and before any
 * agent code runs. One timeline is the only way to assert both at once.
 */
const timeline: string[] = [];
let updateNetworkImpl: (network: Record<string, unknown>) => Promise<void> = async () => {};
let omitUpdateNetwork = false;

const sandboxStub = {
  commands: {
    run: (command: string, options: Record<string, unknown>) => {
      runCalls.push({ command, options });
      timeline.push(command.startsWith("'pip'") ? "pip" : `exec:${command.slice(0, 9)}`);
      return runImpl(command);
    },
  },
  updateNetwork: async (network: Record<string, unknown>) => {
    networkCalls.push(network);
    timeline.push("network");
    await updateNetworkImpl(network);
  },
  files: {
    write: async (path: string, data: string) => {
      fsState.files.set(path, new TextEncoder().encode(data));
    },
    makeDir: async (path: string) => {
      fsState.dirs.add(path);
    },
    read: async (path: string) => {
      const found = fsState.files.get(path);
      if (!found) throw new Error(`ENOENT: no such file '${path}'`);
      return found;
    },
    list: async (path: string) => {
      const prefix = `${path}/`;
      return [...fsState.files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => ({ name: p.slice(prefix.length) }));
    },
  },
  kill: async () => {
    killed++;
  },
};

/**
 * Shared by both mock registrations below — two copies could disagree about
 * `omitUpdateNetwork` and quietly make the outdated-SDK test vacuous.
 */
async function createStub(): Promise<unknown> {
  created++;
  if (omitUpdateNetwork) {
    const { updateNetwork: _omitted, ...rest } = sandboxStub;
    return rest;
  }
  return sandboxStub;
}

void mock.module("e2b", () => ({ Sandbox: { create: createStub } }));

// Dual-package hazard guard (#3409): the plugin loads the SDK with require().
// e2b's exports map does not split import/require today, so the bare mock above
// already covers both — this pins that, so an e2b release that adds a CJS entry
// turns these into failures rather than into live E2B API calls.
try {
  void mock.module(require.resolve("e2b"), () => ({
    Sandbox: { create: createStub },
  }));
} catch {
  // intentionally ignored: SDK not installed — the bare-specifier mock above
  // covers both loaders as a virtual module.
}

// Import AFTER the mocks are in place.
const { buildE2BSandboxPlugin } = await import("../src/index");
import type { PluginPythonOptions } from "@useatlas/plugin-sdk";

const CONFIG = {
  apiKey: "e2b_test_key",
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

/** Make the next `python3` run write a result file, the way the wrapper would. */
function respondWithResult(result: unknown): void {
  runImpl = async (command: string) => {
    const match = /'([^']*result\.json)'/.exec(command);
    // The wrapper learns the result path from the env, not the command line, so
    // derive it from the exec dir the command already names.
    const execDir = /'([^']*)\/wrapper\.py'/.exec(command)?.[1];
    const resultPath = match?.[1] ?? `${execDir}/result.json`;
    fsState.files.set(resultPath, new TextEncoder().encode(JSON.stringify(result)));
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
  runCalls.length = 0;
  networkCalls.length = 0;
  timeline.length = 0;
  killed = 0;
  created = 0;
  runImpl = async () => ({ stdout: "", stderr: "", exitCode: 0 });
  updateNetworkImpl = async () => {};
  omitUpdateNetwork = false;
});

describe("e2b sandbox plugin — Python surface", () => {
  test("declares createPython and an honest egress posture", () => {
    const plugin = buildE2BSandboxPlugin(CONFIG);
    expect(typeof plugin.sandbox.createPython).toBe("function");
    // "enforced" since the issue-4666 re-verify: the e2b SDK 2.45.0 does expose
    // per-sandbox egress control, which #5500 predated.
    expect(plugin.sandbox.pythonEgressControl).toBe("enforced");
  });

  test("round-trips code and data through the org's own E2B sandbox", async () => {
    respondWithResult({ success: true, output: "42" });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("print(42)", { columns: ["n"], rows: [[42]] });

    expect(result).toEqual({ success: true, output: "42" });
    expect(created).toBe(1);
    const pythonRun = runCalls.find((c) => c.command.startsWith("'python3'"))!;
    expect(pythonRun.command).toContain("wrapper.py");
    expect(pythonRun.command).toContain("user_code.py");
    expect(pythonRun.command).toContain("data.json");
    // Timeout parity: the host's budget reaches E2B's own command timeout.
    expect(pythonRun.options.timeoutMs).toBe(30_000);
    expect((pythonRun.options.envs as Record<string, string>).ATLAS_RESULT_FILE).toContain(
      "result.json",
    );
  });

  test("reads chart PNGs back off the sandbox filesystem", async () => {
    runImpl = async (command: string) => {
      const execDir = /'([^']*)\/wrapper\.py'/.exec(command)![1]!;
      fsState.files.set(
        `${execDir}/result.json`,
        new TextEncoder().encode(JSON.stringify({ success: true })),
      );
      fsState.files.set(`${execDir}/charts/chart_0.png`, new Uint8Array([7, 7]));
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("chart_path()");

    expect(result.success).toBe(true);
    expect(result.success && result.charts).toEqual([
      { base64: Buffer.from([7, 7]).toString("base64"), mimeType: "image/png" },
    ]);
  });

  test("treats a non-zero exit thrown by the SDK as a completed run, not an infra fault", async () => {
    // E2B throws on non-zero exit. Tearing the sandbox down there would lose
    // the wrapper's own diagnosis, which is already on disk.
    runImpl = async (command: string) => {
      const execDir = /'([^']*)\/wrapper\.py'/.exec(command)![1]!;
      fsState.files.set(
        `${execDir}/result.json`,
        new TextEncoder().encode(JSON.stringify({ success: false, error: "NameError: x" })),
      );
      throw Object.assign(new Error("command failed"), {
        exitCode: 1,
        stdout: "",
        stderr: "Traceback",
      });
    };
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("print(x)");

    expect(result).toEqual({ success: false, error: "NameError: x" });
    expect(killed).toBe(0);
  });

  test("a missing result file becomes a failure result, not a thrown read error", async () => {
    runImpl = async () => ({ stdout: "", stderr: "Killed", exitCode: 137 });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("import numpy");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe("Killed");
  });

  test("installs the configured packages once, and skips the step when none are configured", async () => {
    respondWithResult({ success: true });
    const withPackages = buildE2BSandboxPlugin({ ...CONFIG, pythonPackages: ["pandas"] });
    const backend = await withPackages.sandbox.createPython!(options());
    await backend.exec("print(1)");
    await backend.exec("print(2)");

    const installs = runCalls.filter((c) => c.command.startsWith("'pip'"));
    // Installed on session creation, not per exec — the install is the slowest
    // part of a cold Python run.
    expect(installs).toHaveLength(1);
    expect(installs[0]!.command).toContain("pandas");

    runCalls.length = 0;
    const withoutPackages = buildE2BSandboxPlugin(CONFIG);
    const bare = await withoutPackages.sandbox.createPython!(options());
    await bare.exec("print(1)");
    expect(runCalls.filter((c) => c.command.startsWith("'pip'"))).toHaveLength(0);
  });

  test("a failing pip install does not fail the Python call", async () => {
    let firstRun = true;
    runImpl = async (command: string) => {
      if (firstRun && command.startsWith("'pip'")) {
        firstRun = false;
        throw new Error("registry unreachable");
      }
      const execDir = /'([^']*)\/wrapper\.py'/.exec(command)?.[1];
      if (execDir) {
        fsState.files.set(
          `${execDir}/result.json`,
          new TextEncoder().encode(JSON.stringify({ success: true, output: "ok" })),
        );
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const plugin = buildE2BSandboxPlugin({ ...CONFIG, pythonPackages: ["pandas"] });
    const backend = await plugin.sandbox.createPython!(options());

    const result = await backend.exec("print('ok')");

    // The user code that needs a missing package reports its own ImportError,
    // which is far more actionable than a sandbox that refused to start.
    expect(result).toEqual({ success: true, output: "ok" });
  });

  // -------------------------------------------------------------------------
  // Egress enforcement (issue 4666 re-verify of #5500's "unsupported")
  // -------------------------------------------------------------------------

  test("cuts the sandbox off the internet when the host asks for deny-all", async () => {
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );
    await backend.exec("print(1)");

    // E2B documents allowInternetAccess: false as equivalent to denying
    // 0.0.0.0/0, and it says so in one field rather than two.
    expect(networkCalls).toEqual([{ allowInternetAccess: false }]);
  });

  test("narrows to the host's datasource hosts on an allowlist", async () => {
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({
        networkPolicy: { mode: "allowlist", hosts: ["crm.example.com", "api.example.com"] },
      }),
    );
    await backend.exec("print(1)");

    // allowOut paired with a deny of everything is E2B's own documented
    // deny-everything-except idiom; allowOut alone would leave the default
    // (all outbound allowed) in play if E2B ever reads an empty deny as open.
    expect(networkCalls).toEqual([
      {
        allowOut: ["crm.example.com", "api.example.com"],
        denyOut: ["0.0.0.0/0"],
      },
    ]);
  });

  test("locks down AFTER pip install and BEFORE any agent code runs", async () => {
    // Narrowing first would cut the sandbox off from PyPI; narrowing last would
    // run the agent's code unbounded.
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin({ ...CONFIG, pythonPackages: ["pandas"] });
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );
    await backend.exec("print(1)");

    expect(timeline.indexOf("pip")).toBeLessThan(timeline.indexOf("network"));
    expect(timeline.indexOf("network")).toBeLessThan(timeline.indexOf("exec:'python3'"));
  });

  test("leaves a fresh sandbox alone when the host asks for allow-all", async () => {
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "allow-all" } }),
    );
    await backend.exec("print(1)");

    expect(networkCalls).toEqual([]);
  });

  test("an empty allowlist is deny-all, never allow-all", async () => {
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "allowlist", hosts: [] } }),
    );
    await backend.exec("print(1)");

    expect(networkCalls).toEqual([{ allowInternetAccess: false }]);
  });

  test("fails the run closed when E2B rejects the policy", async () => {
    // The whole point of declaring "enforced": a refused bound must not become
    // a Python run that ships query rows out of an unbounded sandbox.
    respondWithResult({ success: true });
    updateNetworkImpl = async () => {
      throw new Error("egress rules unsupported on this deployment");
    };
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain(
      "refusing to run Python with an unenforced network bound",
    );
    // No agent code ran, and the sandbox it would have run in is gone.
    expect(runCalls.some((c) => c.command.startsWith("'python3'"))).toBe(false);
    expect(killed).toBe(1);
  });

  test("fails closed on an e2b SDK too old to expose updateNetwork", async () => {
    omitUpdateNetwork = true;
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(
      options({ networkPolicy: { mode: "deny-all" } }),
    );

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("upgrade e2b");
    expect(runCalls.some((c) => c.command.startsWith("'python3'"))).toBe(false);
  });

  test("close tears the sandbox down", async () => {
    respondWithResult({ success: true });
    const plugin = buildE2BSandboxPlugin(CONFIG);
    const backend = await plugin.sandbox.createPython!(options());
    await backend.exec("print(1)");

    await backend.close!();

    expect(killed).toBe(1);
  });
});
