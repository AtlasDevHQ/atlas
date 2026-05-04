/**
 * Tests for the `bunx @useatlas/mcp` dispatcher.
 *
 * Two layers:
 *   1. In-process — exercise the pure parsers + dispatchers directly. cli.ts
 *      gates its `main()` invocation behind `import.meta.main` so importing
 *      the module from a test doesn't auto-run the CLI.
 *   2. Subprocess — spawn `bin/cli.ts` and pin help / unknown-command
 *      contracts (the actual `process.argv` path real users hit). One test
 *      copies the CLI into an isolated tmp tree (no `@atlas/mcp` upstream)
 *      to validate the documented "package missing → #2024" message.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dir, "..");
const CLI = join(PKG_ROOT, "bin", "cli.ts");

// ---------------------------------------------------------------------------
// In-process — pure parser surface
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// Subprocess — argv handling, exit codes, help output
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

describe("cli — init flag parsing", () => {
  it("rejects --client without a value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["init", "--client"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--client expects one of");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects --api-url without a value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["init", "--api-url", "--write"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--api-url expects a URL value");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("cli — serve flag parsing", () => {
  it("rejects --transport without a value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["serve", "--transport"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--transport expects a value");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects --port without a value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["serve", "--port"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--port expects a positive integer");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an invalid transport value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["serve", "--transport", "websocket"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Unknown transport");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a non-positive port", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-mcp-cli-"));
    try {
      const r = await runCli(["serve", "--port", "0"], cwd);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Invalid port");
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
    // that contains JUST cli.ts + its local imports + a peer node_modules
    // for `@modelcontextprotocol/sdk`. Crucially nothing upward has
    // `@atlas/mcp`, so resolution will throw.
    const root = mkdtempSync(join(tmpdir(), "atlas-mcp-isolated-"));
    try {
      const pkg = join(root, "pkg");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(join(pkg, "src", "init"), { recursive: true });

      cpSync(CLI, join(pkg, "bin", "cli.ts"));
      cpSync(join(PKG_ROOT, "src", "init"), join(pkg, "src", "init"), {
        recursive: true,
      });

      // Provide @modelcontextprotocol/sdk so the cli's `await import("@modelcontextprotocol/sdk/...")`
      // call (only reached on stdio after server boot) doesn't fail first;
      // for this test we never get past the @atlas/mcp import anyway.
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
