import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServerConfig,
  mergeMcpServerConfig,
  writeConfigWithBackup,
} from "../../src/init/config-merge.js";

const SERVER_NAME = "atlas";
const SERVER = {
  command: "bunx",
  args: ["@useatlas/mcp", "serve"],
  env: { ATLAS_DATASOURCE_URL: "sqlite:///tmp/demo.sqlite" },
};

describe("buildServerConfig", () => {
  it("emits a bunx command pointing at the public package name", () => {
    const cfg = buildServerConfig({ datasourceUrl: "postgresql://localhost/x" });
    expect(cfg.command).toBe("bunx");
    expect(cfg.args).toEqual(["@useatlas/mcp", "serve"]);
    expect(cfg.env?.ATLAS_DATASOURCE_URL).toBe("postgresql://localhost/x");
  });

  it("omits ATLAS_DATASOURCE_URL when undefined (caller inherits shell env)", () => {
    const cfg = buildServerConfig({ datasourceUrl: undefined });
    expect(cfg.env).toBeUndefined();
  });

  it("never embeds an absolute path in command or args", () => {
    const cfg = buildServerConfig({ datasourceUrl: undefined });
    expect(cfg.command.startsWith("/")).toBe(false);
    for (const a of cfg.args) {
      expect(a.startsWith("/")).toBe(false);
    }
  });
});

describe("mergeMcpServerConfig", () => {
  it("creates a new mcpServers object when input is null (no existing config)", () => {
    const out = mergeMcpServerConfig(null, SERVER_NAME, SERVER);
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers[SERVER_NAME].command).toBe("bunx");
  });

  it("preserves existing servers under mcpServers", () => {
    const existing = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["@modelcontextprotocol/server-github"] },
      },
    });
    const out = mergeMcpServerConfig(existing, SERVER_NAME, SERVER);
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.github.command).toBe("npx");
    expect(parsed.mcpServers[SERVER_NAME].command).toBe("bunx");
  });

  it("overwrites only the named entry, not siblings", () => {
    const existing = JSON.stringify({
      mcpServers: {
        atlas: { command: "old", args: ["old-args"] },
        keep: { command: "x" },
      },
    });
    const out = mergeMcpServerConfig(existing, SERVER_NAME, SERVER);
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.atlas.command).toBe("bunx");
    expect(parsed.mcpServers.keep.command).toBe("x");
  });

  it("preserves top-level keys that are not mcpServers", () => {
    const existing = JSON.stringify({
      otherTopLevel: { foo: "bar" },
      mcpServers: {},
    });
    const out = mergeMcpServerConfig(existing, SERVER_NAME, SERVER);
    const parsed = JSON.parse(out);
    expect(parsed.otherTopLevel).toEqual({ foo: "bar" });
  });

  it("throws a clear error when input is not valid JSON", () => {
    expect(() => mergeMcpServerConfig("{ this is not json", SERVER_NAME, SERVER)).toThrow(
      /not valid JSON/i,
    );
  });

  it("throws when existing config has mcpServers as a non-object", () => {
    const existing = JSON.stringify({ mcpServers: "oops" });
    expect(() => mergeMcpServerConfig(existing, SERVER_NAME, SERVER)).toThrow(
      /mcpServers/i,
    );
  });

  it("throws when the existing config root is a JSON array", () => {
    expect(() => mergeMcpServerConfig("[]", SERVER_NAME, SERVER)).toThrow(
      /JSON object/i,
    );
  });

  it("throws when the existing config root is JSON null", () => {
    expect(() => mergeMcpServerConfig("null", SERVER_NAME, SERVER)).toThrow(
      /JSON object/i,
    );
  });

  it("throws when mcpServers is an array (catches the Array.isArray guard)", () => {
    const existing = JSON.stringify({ mcpServers: [] });
    expect(() => mergeMcpServerConfig(existing, SERVER_NAME, SERVER)).toThrow(
      /mcpServers/i,
    );
  });
});

describe("writeConfigWithBackup", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atlas-mcp-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the config file (and parent dir) when it does not exist; backupPath null", async () => {
    const target = join(dir, "nested", "claude_desktop_config.json");
    const result = await writeConfigWithBackup(target, '{"mcpServers":{}}\n');
    expect(result.backupPath).toBeNull();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"mcpServers":{}}\n');
  });

  it("writes a .bak file before overwriting an existing config", async () => {
    const target = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, '{"mcpServers":{"old":{"command":"x"}}}\n', "utf8");
    const result = await writeConfigWithBackup(target, '{"mcpServers":{}}\n');
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    const bak = readFileSync(result.backupPath!, "utf8");
    expect(bak).toContain("\"old\"");
    const after = readFileSync(target, "utf8");
    expect(after).toBe('{"mcpServers":{}}\n');
  });

  it("writes the config file with mode 0o600 on POSIX (creds-bearing dotfile)", async () => {
    if (process.platform === "win32") return;
    const target = join(dir, "config.json");
    await writeConfigWithBackup(target, "{}");
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not clobber an existing .bak — uses a timestamped suffix", async () => {
    const target = join(dir, "config.json");
    writeFileSync(target, "{}", "utf8");
    writeFileSync(`${target}.bak`, '{"prev-bak":true}', "utf8");
    const result = await writeConfigWithBackup(target, "{}");
    expect(result.backupPath).toBeTruthy();
    expect(result.backupPath).not.toBe(`${target}.bak`);
    expect(readFileSync(`${target}.bak`, "utf8")).toBe('{"prev-bak":true}');
  });
});
