/**
 * `bunx @useatlas/mcp init` flow.
 *
 * Detects the user's MCP client, builds an Atlas server config block, and
 * either prints it to stdout (default) or merges it into the client's
 * config file (with `--write`). `--hosted` is a stub until #2024 lands.
 */

import { detectClients, getDefaultConfigPath, type McpClientId } from "./clients.js";
import {
  buildServerConfig,
  mergeMcpServerConfig,
  readConfigOrNull,
  writeConfigWithBackup,
  type ServerConfig,
} from "./config-merge.js";
import { detectLocalAtlas, resolveApiUrl } from "./local-atlas.js";
import { resolveFixturePaths, shouldUseFixture } from "./fixture.js";

const SERVER_NAME = "atlas";

export interface RunInitOptions {
  mode: "local" | "hosted";
  client?: McpClientId;
  write?: boolean;
  /** Override the resolved config file path (test seam). */
  configPathOverride?: string;
  /** Override the API URL used for local-Atlas detection. */
  apiUrl?: string;
  /** Process env (test seam). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RunInitResult {
  exitCode: number;
}

export async function runInit(options: RunInitOptions): Promise<RunInitResult> {
  if (options.mode === "hosted") {
    return runHostedStub();
  }
  return runLocal(options);
}

function runHostedStub(): RunInitResult {
  console.log(
    [
      "Hosted mode is coming with #2024 — see https://github.com/AtlasDevHQ/atlas/issues/2024",
      "Run `bunx @useatlas/mcp init --local` for now to point an MCP client at a local Atlas",
      "instance or the bundled demo fixture.",
    ].join("\n"),
  );
  return { exitCode: 0 };
}

async function runLocal(opts: RunInitOptions): Promise<RunInitResult> {
  const env = opts.env ?? process.env;
  const apiUrl = opts.apiUrl ?? resolveApiUrl(env);
  const localAtlas = await detectLocalAtlas({ url: apiUrl, fetchImpl: opts.fetchImpl });

  const datasourceUrl = chooseDatasourceUrl({
    env,
    localAtlas,
  });
  const serverCfg = buildServerConfig({ datasourceUrl });

  const clientId = opts.client ?? pickDefaultClient();
  const configPath = opts.configPathOverride ?? getDefaultConfigPath(clientId);

  if (localAtlas) {
    console.log(`local Atlas detected at ${apiUrl} — leaving ATLAS_DATASOURCE_URL unset so MCP inherits your shell env.`);
  } else if (datasourceUrl) {
    console.log(`No ATLAS_DATASOURCE_URL set — using bundled demo fixture at ${datasourceUrl}.`);
    console.log("Override by exporting ATLAS_DATASOURCE_URL before launching your MCP client.");
  }

  if (!opts.write || configPath === null) {
    printPasteSnippet(clientId, serverCfg, configPath);
    return { exitCode: 0 };
  }

  const existing = readConfigOrNull(configPath);
  let merged: string;
  try {
    merged = mergeMcpServerConfig(existing, SERVER_NAME, serverCfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp init] could not merge into existing config (${configPath}): ${msg}`);
    console.error("Aborting — your config was not modified. Pass --no-write to print a snippet instead.");
    return { exitCode: 1 };
  }

  const { backupPath } = await writeConfigWithBackup(configPath, merged);
  console.log(`Wrote ${configPath}`);
  if (backupPath) {
    console.log(`Backed up the previous config to ${backupPath}`);
  }
  console.log("Restart your MCP client to pick up the new server.");
  return { exitCode: 0 };
}

function chooseDatasourceUrl(args: {
  env: NodeJS.ProcessEnv;
  localAtlas: boolean;
}): string | undefined {
  if (args.localAtlas) {
    // Caller already has Atlas running with its own datasource — leave the
    // env block empty so the MCP server inherits the shell env.
    return undefined;
  }
  if (!shouldUseFixture(args.env)) {
    // The caller has set ATLAS_DATASOURCE_URL in their env — same logic:
    // inherit, don't bake the value into a JSON config that lands in a
    // dotfile or repo.
    return undefined;
  }
  return resolveFixturePaths().sqliteUrl;
}

function pickDefaultClient(): McpClientId {
  const clients = detectClients();
  const detected = clients.find((c) => c.detected && c.id !== "generic");
  return detected?.id ?? "claude-desktop";
}

function printPasteSnippet(
  clientId: McpClientId,
  serverCfg: ServerConfig,
  configPath: string | null,
) {
  const snippet = JSON.stringify({ mcpServers: { [SERVER_NAME]: serverCfg } }, null, 2);
  console.log(`# ${clientId}${configPath ? ` — ${configPath}` : ""}`);
  console.log("# Paste the following into your MCP client config:");
  console.log(snippet);
}
