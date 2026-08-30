/**
 * Tests for the shared file-transport Python backend (#3414).
 *
 * The provider SDKs (e2b, @daytonaio/sdk) are optional peer dependencies and
 * absent here, which is the point: the protocol under test is the transport
 * contract itself — argv order, env vars, chart readback, the output cap, the
 * timeout — not any one provider's API. A fake session stands in for the four
 * primitives every provider supplies.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFileTransportPythonBackend,
  enforcePythonEgress,
} from "../python-backend";
import type {
  EnforceablePythonEgress,
  PythonSandboxRunResult,
  PythonSandboxSession,
} from "../python-backend";
import {
  PLUGIN_PYTHON_CHART_DIR_ENV,
  PLUGIN_PYTHON_RESULT_FILE_ENV,
  type PluginPythonOptions,
  type PluginSandboxNetworkPolicy,
} from "../types";

const WRAPPER = "# fake wrapper\n";

function baseOptions(overrides: Partial<PluginPythonOptions> = {}): PluginPythonOptions {
  return {
    wrapperSource: WRAPPER,
    timeoutMs: 5_000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  };
}

interface FakeSessionSpec {
  /** Files the run leaves behind, keyed by absolute path. */
  produce?: (ctx: {
    resultFile: string;
    chartDir: string;
    files: Map<string, Uint8Array>;
  }) => void;
  runResult?: Partial<PythonSandboxRunResult>;
  runImpl?: (timeoutMs: number) => Promise<PythonSandboxRunResult>;
  createError?: Error;
}

function fakeSession(spec: FakeSessionSpec = {}) {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const runs: {
    command: string;
    args: string[];
    env: Record<string, string>;
    timeoutMs: number;
  }[] = [];
  let destroyed = 0;

  const session: PythonSandboxSession = {
    workDir: "/work",
    async mkdir(path) {
      dirs.add(path);
    },
    async writeFile(path, content) {
      files.set(path, new TextEncoder().encode(content));
    },
    async run(command, args, env, timeoutMs) {
      runs.push({ command, args, env, timeoutMs });
      if (spec.runImpl) return spec.runImpl(timeoutMs);
      if (command === "python3") {
        spec.produce?.({
          resultFile: env[PLUGIN_PYTHON_RESULT_FILE_ENV]!,
          chartDir: env[PLUGIN_PYTHON_CHART_DIR_ENV]!,
          files,
        });
      }
      return { stdout: "", stderr: "", exitCode: 0, ...spec.runResult };
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async listDir(path) {
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
    },
    async destroy() {
      destroyed++;
    },
  };

  const adapter = {
    providerName: "Fake",
    async createSession() {
      if (spec.createError) throw spec.createError;
      return session;
    },
  };

  return { session, adapter, files, dirs, runs, destroyed: () => destroyed };
}

function writeJson(files: Map<string, Uint8Array>, path: string, value: unknown): void {
  files.set(path, new TextEncoder().encode(JSON.stringify(value)));
}

describe("createFileTransportPythonBackend", () => {
  it("stages the wrapper, the code and the data, then runs the documented argv", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, files }) =>
        writeJson(files, resultFile, { success: true, output: "42" }),
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("print(42)", { columns: ["n"], rows: [[42]] });

    expect(result).toEqual({ success: true, output: "42" });

    const run = fake.runs.find((r) => r.command === "python3")!;
    // wrapper.py, then user_code.py, then data.json — the order the host's
    // wrapper reads them in (sys.argv[1], sys.argv[2]).
    expect(run.args).toHaveLength(3);
    expect(run.args[0]).toMatch(/wrapper\.py$/);
    expect(run.args[1]).toMatch(/user_code\.py$/);
    expect(run.args[2]).toMatch(/data\.json$/);
    expect(new TextDecoder().decode(fake.files.get(run.args[0]!)!)).toBe(WRAPPER);
    expect(new TextDecoder().decode(fake.files.get(run.args[1]!)!)).toBe("print(42)");
    expect(JSON.parse(new TextDecoder().decode(fake.files.get(run.args[2]!)!))).toEqual({
      columns: ["n"],
      rows: [[42]],
    });
    expect(run.env[PLUGIN_PYTHON_RESULT_FILE_ENV]).toMatch(/result\.json$/);
    expect(run.env[PLUGIN_PYTHON_CHART_DIR_ENV]).toMatch(/charts$/);
    expect(run.env.MPLBACKEND).toBe("Agg");
  });

  it("omits the data argument entirely when no data is passed", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, files }) => writeJson(files, resultFile, { success: true }),
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    await backend.exec("print(1)");

    const run = fake.runs.find((r) => r.command === "python3")!;
    expect(run.args).toHaveLength(2);
  });

  it("reads chart artifacts back off the sandbox and base64-encodes them", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, chartDir, files }) => {
        writeJson(files, resultFile, { success: true, output: "plotted" });
        files.set(`${chartDir}/chart_1.png`, new Uint8Array([1, 2, 3]));
        files.set(`${chartDir}/chart_0.png`, new Uint8Array([4, 5, 6]));
        // Not a chart — must not be collected.
        files.set(`${chartDir}/notes.txt`, new Uint8Array([9]));
      },
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("chart_path()");

    expect(result.success).toBe(true);
    // Sorted by filename, so chart_0 precedes chart_1 regardless of write order.
    expect(result.success && result.charts).toEqual([
      { base64: Buffer.from([4, 5, 6]).toString("base64"), mimeType: "image/png" },
      { base64: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("passes the host's timeout down and enforces it even when the provider ignores it", async () => {
    const fake = fakeSession({
      // A provider whose SDK never honours the argument: the promise simply
      // never settles. Without a host-side race this hangs the tool call.
      runImpl: () => new Promise<PythonSandboxRunResult>(() => {}),
    });
    const backend = createFileTransportPythonBackend(
      baseOptions({ timeoutMs: 40 }),
      fake.adapter,
    );

    const result = await backend.exec("while True: pass");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("timed out after 40ms");
    expect(fake.runs[0]!.timeoutMs).toBe(40);
    // A timeout leaves the sandbox healthy — only the execution was slow — so
    // it must NOT be torn down, matching the in-tree Vercel backend.
    expect(fake.destroyed()).toBe(0);
  });

  it("rejects a result larger than the cap without parsing it", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, files }) =>
        writeJson(files, resultFile, { success: true, output: "x".repeat(2000) }),
    });
    const backend = createFileTransportPythonBackend(
      baseOptions({ maxOutputBytes: 500 }),
      fake.adapter,
    );

    const result = await backend.exec("print('x' * 2000)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("exceeded 1 MB limit");
  });

  it("counts charts against the cap, not just the result payload", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, chartDir, files }) => {
        writeJson(files, resultFile, { success: true, output: "ok" });
        files.set(`${chartDir}/chart_0.png`, new Uint8Array(900));
      },
    });
    const backend = createFileTransportPythonBackend(
      baseOptions({ maxOutputBytes: 300 }),
      fake.adapter,
    );

    const result = await backend.exec("chart_path()");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("exceeded 1 MB limit");
  });

  it("surfaces stderr when the interpreter died before writing a result file", async () => {
    const fake = fakeSession({
      runResult: { exitCode: 137, stderr: "Killed" },
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("import numpy; numpy.zeros(10**10)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe("Killed");
  });

  it("names the exit code when the interpreter died silently", async () => {
    const fake = fakeSession({ runResult: { exitCode: 2 } });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("exit code 2");
  });

  it("reports unparseable wrapper output rather than throwing", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, files }) =>
        files.set(resultFile, new TextEncoder().encode("{not json")),
      runResult: { stderr: "Traceback: boom" },
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("unparseable output");
    expect(result.success === false && result.error).toContain("Traceback: boom");
  });

  it("scrubs credential values out of stderr and infrastructure errors", async () => {
    const secret = "prov_secret_abcdef";
    const fake = fakeSession({
      runResult: { exitCode: 1, stderr: `401 rejected key ${secret}` },
    });
    const backend = createFileTransportPythonBackend(
      baseOptions({
        scrubErrorDetail: (detail) => detail.split(secret).join("[REDACTED]"),
      }),
      fake.adapter,
    );

    const result = await backend.exec("print(1)");

    expect(result.success === false && result.error).not.toContain(secret);
    expect(result.success === false && result.error).toContain("[REDACTED]");
  });

  it("returns a failure result — never throws — when the sandbox cannot be created", async () => {
    const fake = fakeSession({ createError: new Error("provider is down") });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("provider is down");
  });

  it("does not report a failed creation as a failed teardown", async () => {
    // A session that never came up has nothing to tear down. Logging the
    // creation error again under "Failed to destroy" puts the wrong sentence
    // in front of an operator — and a fail-closed egress refusal makes
    // creation failure a routine path, not an exotic one.
    const warnings: string[] = [];
    const fake = fakeSession({ createError: new Error("403 egress policy refused") });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter, {
      warn: (msg) => warnings.push(msg),
    });

    const result = await backend.exec("print(1)");
    // The invalidate() cleanup is fire-and-forget; let its microtasks drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(result.success === false && result.error).toContain("403 egress policy refused");
    expect(warnings.filter((w) => w.includes("Failed to destroy"))).toEqual([]);
  });

  it("discards the session after an infrastructure failure so the next call starts clean", async () => {
    let attempt = 0;
    const fake = fakeSession({
      runImpl: async () => {
        attempt++;
        if (attempt === 1) throw new Error("sandbox vanished");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const first = await backend.exec("print(1)");
    expect(first.success).toBe(false);
    // Torn down, unlike the timeout case above — the sandbox itself is suspect.
    expect(fake.destroyed()).toBe(1);
  });

  it("passes a plugin-declared failure result through untouched", async () => {
    const fake = fakeSession({
      produce: ({ resultFile, files }) =>
        writeJson(files, resultFile, { success: false, error: "NameError: x" }),
    });
    const backend = createFileTransportPythonBackend(baseOptions(), fake.adapter);

    const result = await backend.exec("print(x)");

    expect(result).toEqual({ success: false, error: "NameError: x" });
  });
});

describe("enforcePythonEgress", () => {
  function recorder(): {
    seen: EnforceablePythonEgress[];
    apply: (policy: EnforceablePythonEgress) => Promise<void>;
  } {
    const seen: EnforceablePythonEgress[] = [];
    return {
      seen,
      apply: async (policy) => {
        seen.push(policy);
      },
    };
  }

  it("passes deny-all straight through", async () => {
    const rec = recorder();
    await enforcePythonEgress({ mode: "deny-all" }, "Test", rec.apply);
    expect(rec.seen).toEqual([{ mode: "deny-all" }]);
  });

  it("passes a non-empty allowlist through with its hosts", async () => {
    const rec = recorder();
    await enforcePythonEgress(
      { mode: "allowlist", hosts: ["crm.example.com"] },
      "Test",
      rec.apply,
    );
    expect(rec.seen).toEqual([{ mode: "allowlist", hosts: ["crm.example.com"] }]);
  });

  it("resolves an empty allowlist to deny-all, never to allow-all", async () => {
    // The same fail-closed normalisation the host applies on its side. A
    // provider must never be handed a shape it could read as "allow".
    const rec = recorder();
    await enforcePythonEgress({ mode: "allowlist", hosts: [] }, "Test", rec.apply);
    expect(rec.seen).toEqual([{ mode: "deny-all" }]);
  });

  it("calls the provider for neither an absent policy nor allow-all", async () => {
    // A fresh per-request sandbox already starts unrestricted, so there is
    // nothing to relax — and calling anyway would invent a failure mode for a
    // policy that bounds nothing.
    const rec = recorder();
    await enforcePythonEgress(undefined, "Test", rec.apply);
    await enforcePythonEgress({ mode: "allow-all" }, "Test", rec.apply);
    expect(rec.seen).toEqual([]);
  });

  it("throws — naming the provider, the mode and the cause — when apply fails", async () => {
    // The throw is what makes `pythonEgressControl: "enforced"` a promise:
    // the caller aborts the session rather than running the agent's Python in
    // a sandbox whose egress bound was refused.
    const cause = new Error("403 Forbidden: requires Tier 3");
    let thrown: unknown;
    try {
      await enforcePythonEgress({ mode: "deny-all" }, "Daytona", async () => {
        throw cause;
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("Daytona");
    expect(message).toContain("deny-all");
    expect(message).toContain("refusing to run Python with an unenforced network bound");
    expect(message).toContain("403 Forbidden: requires Tier 3");
    expect(thrown instanceof Error ? thrown.cause : undefined).toBe(cause);
  });

  it("accepts every PluginSandboxNetworkPolicy shape the host can produce", async () => {
    // toPluginNetworkPolicy emits exactly these three; none may throw here.
    const policies: PluginSandboxNetworkPolicy[] = [
      { mode: "deny-all" },
      { mode: "allow-all" },
      { mode: "allowlist", hosts: ["a.example.com"] },
    ];
    for (const policy of policies) {
      await enforcePythonEgress(policy, "Test", async () => {});
    }
  });
});

describe("plugin-facing Python types", () => {
  it("import nothing from the API package (#3414 acceptance criterion)", () => {
    // A claim in a doc comment cannot fail; this can. A plugin author installs
    // @useatlas/plugin-sdk alone, so any @atlas/api import here breaks every
    // plugin build — and the failure would land on them, not on us.
    const srcDir = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(srcDir, name), "utf-8");
      // Import/export statements only — the doc comments legitimately name the
      // package when explaining what a type mirrors.
      const pattern = /^\s*(?:import|export)\s[^;]*?from\s+["']@atlas\/[^"']+["']/gm;
      if (pattern.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
