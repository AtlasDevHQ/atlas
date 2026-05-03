import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../init/index.js";

const HEALTHY = (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;
const UNREACHABLE = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

function captureStdio(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    logs,
    errs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

describe("runInit --hosted (stub)", () => {
  it("prints a 'coming with #2024' message and exits non-fatally", async () => {
    const cap = captureStdio();
    try {
      const res = await runInit({ mode: "hosted" });
      expect(res.exitCode).toBe(0);
      const out = [...cap.logs, ...cap.errs].join("\n");
      expect(out).toMatch(/#2024/);
      expect(out).toMatch(/hosted/i);
    } finally {
      cap.restore();
    }
  });
});

describe("runInit --local (print-only, no --write)", () => {
  it("prints a JSON snippet that uses bunx @useatlas/mcp serve", async () => {
    const cap = captureStdio();
    try {
      const res = await runInit({
        mode: "local",
        client: "claude-desktop",
        write: false,
        env: {},
        fetchImpl: UNREACHABLE,
      });
      expect(res.exitCode).toBe(0);
      const out = cap.logs.join("\n");
      expect(out).toContain("\"command\": \"bunx\"");
      expect(out).toContain("\"@useatlas/mcp\"");
      expect(out).toContain("\"serve\"");
    } finally {
      cap.restore();
    }
  });

  it("falls back to the bundled fixture when ATLAS_DATASOURCE_URL is unset", async () => {
    const cap = captureStdio();
    try {
      await runInit({
        mode: "local",
        client: "claude-desktop",
        write: false,
        env: {},
        fetchImpl: UNREACHABLE,
      });
      const out = cap.logs.join("\n");
      expect(out).toContain("ATLAS_DATASOURCE_URL");
      expect(out).toContain("sqlite://");
    } finally {
      cap.restore();
    }
  });

  it("prefers a local Atlas if /api/v1/health responds", async () => {
    const cap = captureStdio();
    try {
      await runInit({
        mode: "local",
        client: "claude-desktop",
        write: false,
        env: {},
        fetchImpl: HEALTHY,
      });
      const out = cap.logs.join("\n");
      // When a local Atlas is detected we leave ATLAS_DATASOURCE_URL out so
      // the MCP server inherits whatever the user's shell already exports.
      expect(out).not.toContain("sqlite://");
      expect(out).toMatch(/local Atlas detected/i);
    } finally {
      cap.restore();
    }
  });
});

describe("runInit --local --write", () => {
  it("writes the merged config to the configPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-"));
    const target = join(dir, "claude_desktop_config.json");
    writeFileSync(
      target,
      JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["mcp-github"] } },
      }),
      "utf8",
    );
    const cap = captureStdio();
    try {
      const res = await runInit({
        mode: "local",
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        env: {},
        fetchImpl: UNREACHABLE,
      });
      expect(res.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.mcpServers.atlas.command).toBe("bunx");
      expect(written.mcpServers.github.command).toBe("npx");
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the config when one does not yet exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-"));
    const target = join(dir, "nested", "claude_desktop_config.json");
    const cap = captureStdio();
    try {
      const res = await runInit({
        mode: "local",
        client: "claude-desktop",
        write: true,
        configPathOverride: target,
        env: {},
        fetchImpl: UNREACHABLE,
      });
      expect(res.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.mcpServers.atlas.command).toBe("bunx");
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
