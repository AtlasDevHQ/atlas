/**
 * Tests for the `bunx @useatlas/mcp` dispatcher.
 *
 * Layered approach:
 *   1. Pure parsers + predicates — exercised in-process via direct imports.
 *      Parsers throw `CliUsageError`, so negative cases are testable without
 *      subprocess spawns.
 *   2. End-to-end help / unknown-command — subprocess spawn pins the real
 *      `process.argv` path users hit.
 *   3. Resolution-error contract — subprocess spawn from an isolated tmp
 *      tree (no `@atlas/mcp` upstream) so the dynamic import genuinely
 *      throws ERR_MODULE_NOT_FOUND.
 */
import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const CLI = join(PKG_ROOT, "bin", "cli.ts");

// ---------------------------------------------------------------------------
// Pure parsers — in-process throw assertions
// ---------------------------------------------------------------------------

describe("parseInitArgs", () => {
  it("returns sensible defaults for an empty argv", async () => {
    const { parseInitArgs } = await import("../bin/cli.js");
    expect(parseInitArgs([])).toEqual({
      mode: "local",
      client: undefined,
      write: false,
      apiUrl: undefined,
      help: false,
    });
  });

  it("rejects --client without a value", async () => {
    const { parseInitArgs, CliUsageError } = await import("../bin/cli.js");
    expect(() => parseInitArgs(["--client"])).toThrow(CliUsageError);
    expect(() => parseInitArgs(["--client"])).toThrow(/--client expects one of/);
  });

  it("rejects --client with an unknown id", async () => {
    const { parseInitArgs } = await import("../bin/cli.js");
    expect(() => parseInitArgs(["--client", "vim"])).toThrow(/--client expects one of/);
  });

  it("rejects --api-url without a value", async () => {
    const { parseInitArgs } = await import("../bin/cli.js");
    expect(() => parseInitArgs(["--api-url", "--write"])).toThrow(
      /--api-url expects a URL value/,
    );
  });

  it("rejects unknown flags", async () => {
    const { parseInitArgs } = await import("../bin/cli.js");
    expect(() => parseInitArgs(["--frobnicate"])).toThrow(/Unknown flag: --frobnicate/);
  });
});

describe("parseServeArgs", () => {
  it("defaults to stdio transport on port 8080", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(parseServeArgs([])).toEqual({ transport: "stdio", port: 8080 });
  });

  it("accepts --transport sse and a port override", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(parseServeArgs(["--transport", "sse", "--port", "9090"])).toEqual({
      transport: "sse",
      port: 9090,
    });
  });

  it("rejects --transport without a value", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(() => parseServeArgs(["--transport"])).toThrow(/--transport expects a value/);
  });

  it("rejects an invalid transport value", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(() => parseServeArgs(["--transport", "websocket"])).toThrow(/Unknown transport/);
  });

  it("rejects --port without a value", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(() => parseServeArgs(["--port"])).toThrow(/--port expects a positive integer/);
  });

  it("rejects a non-positive port", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(() => parseServeArgs(["--port", "0"])).toThrow(/Invalid port/);
    expect(() => parseServeArgs(["--port", "-1"])).toThrow(/Invalid port/);
    expect(() => parseServeArgs(["--port", "not-a-number"])).toThrow(/Invalid port/);
  });

  it("rejects unknown flags", async () => {
    const { parseServeArgs } = await import("../bin/cli.js");
    expect(() => parseServeArgs(["--frobnicate"])).toThrow(/Unknown flag: --frobnicate/);
  });
});

// ---------------------------------------------------------------------------
// isModuleNotFound — pure predicate, every branch
// ---------------------------------------------------------------------------

describe("isModuleNotFound", () => {
  it("matches Node ERR_MODULE_NOT_FOUND", async () => {
    const { isModuleNotFound } = await import("../bin/cli.js");
    const err = Object.assign(new Error("nope"), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isModuleNotFound(err)).toBe(true);
  });

  it("matches legacy Node MODULE_NOT_FOUND", async () => {
    const { isModuleNotFound } = await import("../bin/cli.js");
    const err = Object.assign(new Error("nope"), { code: "MODULE_NOT_FOUND" });
    expect(isModuleNotFound(err)).toBe(true);
  });

  it("matches Bun's ResolveMessage by class name", async () => {
    const { isModuleNotFound } = await import("../bin/cli.js");
    class ResolveMessage {
      message = "synthetic";
    }
    expect(isModuleNotFound(new ResolveMessage())).toBe(true);
  });

  it("matches the message-shape fallback", async () => {
    const { isModuleNotFound } = await import("../bin/cli.js");
    expect(isModuleNotFound(new Error("Cannot find module 'foo'"))).toBe(true);
    expect(isModuleNotFound(new Error("Cannot find package 'foo'"))).toBe(true);
  });

  it("rejects non-resolution errors", async () => {
    const { isModuleNotFound } = await import("../bin/cli.js");
    expect(isModuleNotFound(new Error("DATABASE_URL is required"))).toBe(false);
    expect(isModuleNotFound(new Error("connection lost"))).toBe(false);
  });

  it("rejects non-object inputs", async () => {
    const { isModuleNotFound } = await import("../bin/cli.js");
    expect(isModuleNotFound(null)).toBe(false);
    expect(isModuleNotFound(undefined)).toBe(false);
    expect(isModuleNotFound("Cannot find module 'foo'")).toBe(false);
    expect(isModuleNotFound(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runInitCommand — hosted short-circuit pin
// ---------------------------------------------------------------------------

describe("runInitCommand — hosted mode", () => {
  it("intentionally drops --write / --client / --api-url when --hosted is passed", async () => {
    // Capture stdout — the hosted stub prints the #2024 link rather than
    // touching the filesystem. Pinning the discard prevents a future
    // refactor from accidentally honoring --write while the hosted
    // backend doesn't exist yet (#2024).
    const { runInitCommand } = await import("../bin/cli.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    try {
      const code = await runInitCommand(["--hosted", "--write", "--client", "cursor"]);
      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toMatch(/issues\/2024/);
      // No filesystem write, no client-specific path
      expect(out).not.toContain("Wrote ");
    } finally {
      console.log = origLog;
    }
  });
});

// ---------------------------------------------------------------------------
// Subprocess — exit codes + help output for real argv handling
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  cwd: string,
  cliPath: string = CLI,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

describe("cli — top-level dispatch", () => {
  it("exits 0 with help when invoked with no args", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli([], cwd);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("bunx @useatlas/mcp <command>");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exits 0 with help on --help", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["--help"], cwd);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Commands:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exits 1 on unknown subcommand", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["bogus"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Unknown command: bogus");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Resolution error — copy the package into an isolated tmp tree (no
// `@atlas/mcp` anywhere upward) so the dynamic import genuinely fails with
// ERR_MODULE_NOT_FOUND. This is the contract the published-package user
// sees when they run `bunx @useatlas/mcp serve` without an Atlas project.
// ---------------------------------------------------------------------------

describe("cli — serve fails cleanly when @atlas/mcp can't be resolved", () => {
  it("prints the #2024 link and exits 1", async () => {
    // Build an isolated package tree at /tmp/atlas-mcp-isolated-XXX/pkg
    // that contains JUST cli.ts + its local imports. Crucially nothing
    // upward has `@atlas/mcp`, so resolution will throw.
    //
    // Hard-fail if `tmpdir()` resolves under the monorepo (e.g. CI runners
    // with `TMPDIR=$RUNNER_TEMP` inside the workspace) — Bun's resolver
    // walks upward from the script path and would find `@atlas/mcp` via
    // workspace hoist, silently flipping the assertion.
    const realTmp = realpathSync(tmpdir());
    const realRepo = realpathSync(REPO_ROOT);
    if (realTmp === realRepo || realTmp.startsWith(realRepo + "/")) {
      throw new Error(
        `tmpdir (${realTmp}) is inside the monorepo (${realRepo}); the isolated-tree test would silently pass via workspace hoist. Set TMPDIR to a location outside ${realRepo}.`,
      );
    }

    const root = mkdtempSync(join(tmpdir(), "atlas-mcp-isolated-"));
    try {
      const pkg = join(root, "pkg");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(join(pkg, "src", "init"), { recursive: true });

      cpSync(CLI, join(pkg, "bin", "cli.ts"));
      cpSync(join(PKG_ROOT, "src", "init"), join(pkg, "src", "init"), {
        recursive: true,
      });

      // We never reach the @modelcontextprotocol/sdk import — the
      // @atlas/mcp/server resolution fails first — so an empty tree
      // is enough to exercise the documented contract.
      writeFileSync(join(pkg, "package.json"), JSON.stringify({
        name: "atlas-mcp-isolated",
        type: "module",
      }));
      mkdirSync(join(pkg, "node_modules"), { recursive: true });

      const r = await runCli(["serve"], pkg, join(pkg, "bin", "cli.ts"));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Could not resolve `@atlas/mcp`");
      expect(r.stderr).toContain(
        "https://github.com/AtlasDevHQ/atlas/issues/2024",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runServeCommand shutdown — exit 0 on clean close, exit 1 on close failure.
// Pinned via a fake `@atlas/mcp/server` module so we never touch the real
// stack (which needs DATABASE_URL etc.).
// ---------------------------------------------------------------------------

describe("runServeCommand — shutdown exit codes", () => {
  // We can't use bun:test's mock.module reliably here (factory throws don't
  // propagate as ResolveMessage; module cache is process-global). Instead
  // we run a small inline driver in a subprocess that imports cli.ts and
  // injects a fake module via `mock.module` itself before invoking
  // `runServeCommand`. Subprocess isolation prevents bleed across cases.
  async function runShutdownCase(closeBehaviour: "clean" | "throws"): Promise<RunResult> {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-shutdown-"));
    try {
      const driver = join(cwd, "driver.ts");
      const cliFromCwd = JSON.stringify(CLI);
      writeFileSync(
        driver,
        `import { mock } from "bun:test";
const closeBehaviour = ${JSON.stringify(closeBehaviour)};
mock.module("@atlas/mcp/server", () => ({
  createAtlasMcpServer: async () => ({
    connect: async (_t: unknown) => {},
    close: async () => {
      if (closeBehaviour === "throws") {
        throw new Error("synthetic close failure");
      }
    },
  }),
}));
mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class { close() {} },
}));
const { runServeCommand } = await import(${cliFromCwd});
const pending = runServeCommand([]);
// Give the boot pipeline a microtask to register signal handlers + log
// the "Server running on stdio" line, then send SIGTERM.
await new Promise((r) => setTimeout(r, 50));
process.kill(process.pid, "SIGTERM");
const code = await pending;
console.log("EXIT_CODE=" + code);
process.exit(0);
`,
      );
      const proc = Bun.spawn(["bun", driver], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode: proc.exitCode ?? -1, stdout, stderr };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it("resolves 0 when close() succeeds on SIGTERM", async () => {
    const r = await runShutdownCase("clean");
    expect(r.stdout).toContain("EXIT_CODE=0");
  });

  it("resolves 1 when close() throws on SIGTERM", async () => {
    const r = await runShutdownCase("throws");
    expect(r.stdout).toContain("EXIT_CODE=1");
    expect(r.stderr).toContain("synthetic close failure");
  });
});
