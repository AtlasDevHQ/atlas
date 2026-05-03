/**
 * MCP client config merging.
 *
 * Builds a `mcpServers["<name>"]` block, merges it into an existing JSON
 * config (preserving sibling servers + non-mcp top-level keys), and writes
 * the result with a `.bak` of any previous file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface BuildOpts {
  /** Inline ATLAS_DATASOURCE_URL into the env block. Omit to inherit the user's shell env. */
  datasourceUrl?: string;
  /** Override the package name used in the bunx invocation. Defaults to @useatlas/mcp. */
  packageName?: string;
}

const DEFAULT_PACKAGE = "@useatlas/mcp";

export function buildServerConfig(opts: BuildOpts = {}): ServerConfig {
  const pkg = opts.packageName ?? DEFAULT_PACKAGE;
  const cfg: ServerConfig = {
    command: "bunx",
    args: [pkg, "serve"],
  };
  if (opts.datasourceUrl) {
    cfg.env = { ATLAS_DATASOURCE_URL: opts.datasourceUrl };
  }
  return cfg;
}

interface ExistingShape {
  mcpServers?: unknown;
  [key: string]: unknown;
}

export function mergeMcpServerConfig(
  existingJson: string | null,
  serverName: string,
  serverConfig: ServerConfig,
): string {
  let parsed: ExistingShape = {};
  if (existingJson !== null) {
    try {
      const raw = JSON.parse(existingJson) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Existing config root must be a JSON object");
      }
      parsed = raw as ExistingShape;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Existing config is not valid JSON: ${msg}`, { cause: err });
    }
  }

  const existingServers = parsed.mcpServers;
  let serversObj: Record<string, ServerConfig>;
  if (existingServers === undefined) {
    serversObj = {};
  } else if (
    existingServers === null ||
    typeof existingServers !== "object" ||
    Array.isArray(existingServers)
  ) {
    throw new Error(
      "Existing config has a non-object value at `mcpServers` — refusing to overwrite",
    );
  } else {
    serversObj = { ...(existingServers as Record<string, ServerConfig>) };
  }

  serversObj[serverName] = serverConfig;
  const merged: ExistingShape = { ...parsed, mcpServers: serversObj };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

export interface WriteResult {
  /** Path to the .bak file we wrote, or null if no prior config existed. */
  backupPath: string | null;
}

export async function writeConfigWithBackup(
  configPath: string,
  newContent: string,
): Promise<WriteResult> {
  let backupPath: string | null = null;

  if (existsSync(configPath)) {
    backupPath = `${configPath}.bak`;
    if (existsSync(backupPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${configPath}.${stamp}.bak`;
    }
    copyFileSync(configPath, backupPath);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  writeFileSync(configPath, newContent, { encoding: "utf8", mode: 0o600 });
  return { backupPath };
}

export function readConfigOrNull(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  return readFileSync(configPath, "utf8");
}
