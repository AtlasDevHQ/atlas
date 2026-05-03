import { describe, expect, it } from "bun:test";
import { detectClients, getDefaultConfigPath } from "../../init/clients.js";

const HOME_DARWIN = "/Users/test";
const HOME_LINUX = "/home/test";
const HOME_WINDOWS = "C:\\Users\\test";

describe("getDefaultConfigPath", () => {
  it("returns the macOS Claude Desktop path", () => {
    const p = getDefaultConfigPath("claude-desktop", { home: HOME_DARWIN, platform: "darwin" });
    expect(p).toBe(`${HOME_DARWIN}/Library/Application Support/Claude/claude_desktop_config.json`);
  });

  it("returns the Linux Claude Desktop path under XDG config", () => {
    const p = getDefaultConfigPath("claude-desktop", { home: HOME_LINUX, platform: "linux" });
    expect(p).toBe(`${HOME_LINUX}/.config/Claude/claude_desktop_config.json`);
  });

  it("returns the Windows Claude Desktop path", () => {
    const p = getDefaultConfigPath("claude-desktop", { home: HOME_WINDOWS, platform: "win32" });
    expect(p).not.toBeNull();
    expect(p!.includes("Claude")).toBe(true);
    expect(p!.endsWith("claude_desktop_config.json")).toBe(true);
  });

  it("returns the Cursor path under ~/.cursor on all platforms", () => {
    const macP = getDefaultConfigPath("cursor", { home: HOME_DARWIN, platform: "darwin" });
    expect(macP).toBe(`${HOME_DARWIN}/.cursor/mcp.json`);
    const linP = getDefaultConfigPath("cursor", { home: HOME_LINUX, platform: "linux" });
    expect(linP).toBe(`${HOME_LINUX}/.cursor/mcp.json`);
  });

  it("returns the Continue path under ~/.continue", () => {
    const p = getDefaultConfigPath("continue", { home: HOME_DARWIN, platform: "darwin" });
    expect(p).toBe(`${HOME_DARWIN}/.continue/config.json`);
  });

  it("returns null for the generic client (no config file)", () => {
    const p = getDefaultConfigPath("generic", { home: HOME_DARWIN, platform: "darwin" });
    expect(p).toBeNull();
  });
});

describe("detectClients", () => {
  it("returns an entry for every known client and never throws on a fresh machine", () => {
    const clients = detectClients({ home: HOME_DARWIN, platform: "darwin", existsSync: () => false });
    const ids = clients.map((c) => c.id).sort();
    expect(ids).toEqual(["claude-desktop", "continue", "cursor", "generic"]);
    for (const c of clients) {
      if (c.id === "generic") {
        expect(c.detected).toBe(false);
        expect(c.configPath).toBeNull();
      } else {
        expect(typeof c.configPath).toBe("string");
        expect(c.detected).toBe(false);
      }
    }
  });

  it("marks a client detected when its config file exists", () => {
    const clientsCfg = `${HOME_DARWIN}/Library/Application Support/Claude/claude_desktop_config.json`;
    const clients = detectClients({
      home: HOME_DARWIN,
      platform: "darwin",
      existsSync: (p: string) => p === clientsCfg,
    });
    const claude = clients.find((c) => c.id === "claude-desktop");
    expect(claude?.detected).toBe(true);
    const cursor = clients.find((c) => c.id === "cursor");
    expect(cursor?.detected).toBe(false);
  });
});
