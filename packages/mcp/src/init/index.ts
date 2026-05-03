/**
 * Runs the `init` flow: detect the user's MCP client, build an Atlas server
 * config block, and either print it to stdout (default) or merge it into
 * the client's config file (`--write`).
 */

import { detectClients, getDefaultConfigPath, type ClientInfo, type McpClientId } from "./clients.js";
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
const HOSTED_TRACKING_ISSUE = "https://github.com/AtlasDevHQ/atlas/issues/2024";

export interface LocalInitOptions {
  mode: "local";
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
  /** Test seam — defaults to filesystem-backed `detectClients()`. */
  detectClientsImpl?: () => ClientInfo[];
}

export interface HostedInitOptions {
  mode: "hosted";
}

export type RunInitOptions = LocalInitOptions | HostedInitOptions;

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
      `Hosted mode (against app.useatlas.dev) is not yet available — tracking at ${HOSTED_TRACKING_ISSUE}.`,
      "Run `bunx @useatlas/mcp init --local` for now to point an MCP client at a local Atlas",
      "instance or the bundled demo fixture.",
    ].join("\n"),
  );
  return { exitCode: 0 };
}

async function runLocal(opts: LocalInitOptions): Promise<RunInitResult> {
  const env = opts.env ?? process.env;
  const apiUrl = opts.apiUrl ?? resolveApiUrl(env);
  const localAtlas = await detectLocalAtlas({ url: apiUrl, fetchImpl: opts.fetchImpl });

  const datasourceUrl = chooseDatasourceUrl({
    env,
    localAtlas,
  });
  const serverCfg = buildServerConfig({ datasourceUrl });

  const clientId = opts.client ?? pickDefaultClient(opts.detectClientsImpl);
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
    console.error("Aborting — your config was not modified. Re-run without --write to print a snippet instead.");
    return { exitCode: 1 };
  }

  let writeResult;
  try {
    writeResult = await writeConfigWithBackup(configPath, merged);
  } catch (err) {
    // The .bak (if any) was written *before* the failed write, so a partial
    // failure may have moved the original out of place. Tell the user where
    // to recover from instead of leaving them with a generic "Fatal".
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp init] failed to write ${configPath}: ${msg}`);
    if (existing !== null) {
      console.error(`A backup of your previous config is at ${configPath}.bak (or a timestamped sibling).`);
      console.error(`Restore with: cp '${configPath}.bak' '${configPath}'`);
    }
    return { exitCode: 1 };
  }

  console.log(`Wrote ${configPath}`);
  if (writeResult.backupPath) {
    console.log(`Backed up the previous config to ${writeResult.backupPath}`);
  }
  console.log("Restart your MCP client to pick up the new server.");
  return { exitCode: 0 };
}

function chooseDatasourceUrl(args: {
  env: NodeJS.ProcessEnv;
  localAtlas: boolean;
}): string | undefined {
  // When the caller already has Atlas running OR has ATLAS_DATASOURCE_URL set
  // in their shell, leave the env block empty so MCP inherits the shell —
  // and so we never bake credentials into a JSON file that lives in a dotfile.
  if (args.localAtlas) return undefined;
  if (!shouldUseFixture(args.env)) return undefined;
  return resolveFixturePaths().sqliteUrl;
}

function pickDefaultClient(impl?: () => ClientInfo[]): McpClientId {
  const clients = (impl ?? detectClients)();
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
