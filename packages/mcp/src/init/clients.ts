/**
 * MCP client detection — finds the default config-file path for known clients
 * (Claude Desktop, Cursor, Continue) on macOS, Linux, and Windows.
 *
 * Pure functions over an injectable `home`, `platform`, and `existsSync`
 * so tests run cross-platform without touching the real filesystem.
 */

import { existsSync as fsExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type McpClientId = "claude-desktop" | "cursor" | "continue" | "generic";

export interface ClientInfo {
  id: McpClientId;
  name: string;
  /** Path to the client's MCP config file, or null for the generic stub. */
  configPath: string | null;
  /** True when the config file currently exists on disk. */
  detected: boolean;
}

interface PathOpts {
  home?: string;
  platform?: NodeJS.Platform;
}

interface DetectOpts extends PathOpts {
  existsSync?: (p: string) => boolean;
}

const KNOWN_CLIENTS: ReadonlyArray<{ id: McpClientId; name: string }> = [
  { id: "claude-desktop", name: "Claude Desktop" },
  { id: "cursor", name: "Cursor" },
  { id: "continue", name: "Continue" },
  { id: "generic", name: "Generic MCP client" },
];

function resolveHome(opts: PathOpts): string {
  return opts.home ?? homedir();
}

function resolvePlatform(opts: PathOpts): NodeJS.Platform {
  return opts.platform ?? process.platform;
}

export function getDefaultConfigPath(id: McpClientId, opts: PathOpts = {}): string | null {
  const home = resolveHome(opts);
  const platform = resolvePlatform(opts);

  switch (id) {
    case "claude-desktop":
      if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform === "win32") {
        return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
      }
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "continue":
      return join(home, ".continue", "config.json");
    case "generic":
      return null;
  }
}

export function detectClients(opts: DetectOpts = {}): ClientInfo[] {
  const exists = opts.existsSync ?? fsExistsSync;
  return KNOWN_CLIENTS.map(({ id, name }) => {
    const configPath = getDefaultConfigPath(id, opts);
    const detected = configPath !== null && exists(configPath);
    return { id, name, configPath, detected };
  });
}
