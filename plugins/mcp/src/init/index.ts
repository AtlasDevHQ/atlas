/**
 * Runs the `init` flow: detect the user's MCP client, build an Atlas server
 * config block, and either print it to stdout (default) or merge it into
 * the client's config file (`--write`).
 */

import { detectClients, getDefaultConfigPath, type ClientInfo, type McpClientId } from "./clients.js";
import {
  buildHostedServerConfig,
  buildServerConfig,
  mergeMcpServerConfig,
  readConfigOrNull,
  writeConfigWithBackup,
  type ServerConfig,
} from "./config-merge.js";
import { detectLocalAtlas, resolveApiUrl } from "./local-atlas.js";
import { resolveFixturePaths, shouldUseFixture } from "./fixture.js";
import {
  HostedFlowError,
  runHostedAuthFlow,
  type HostedFlowOptions,
  type OpenBrowserImpl,
  type ServeImpl,
} from "./hosted.js";

// Re-exported so downstream packages (the canonical MCP eval in
// `packages/mcp/src/__tests__/canonical-mcp-auth.ts`) can drive the
// real OAuth 2.1 loopback flow against an in-process server. The flow's
// implementation lives in `./hosted.ts` but we keep the import surface
// flat so a single `import { runHostedAuthFlow, ... } from
// "@useatlas/mcp/init"` covers everything callers need.
export {
  HostedFlowError,
  runHostedAuthFlow,
  type Bearer,
  type HostedFlowErrorCode,
  type HostedFlowOptions,
  type HostedFlowResult,
  type LoopbackHandler,
  type LoopbackServer,
  type OpenBrowserImpl,
  type OpenBrowserResult,
  type ServeImpl,
} from "./hosted.js";

const SERVER_NAME = "atlas";
// #2068 — `mcp.useatlas.dev` is the brand surface for the hosted MCP
// endpoint. DNS CNAMEs fan it (and the regional siblings
// `mcp-eu`/`mcp-apac.useatlas.dev`) into the same Railway services as
// the underlying `api.*` hosts. Defaulting here means the standard
// `bunx @useatlas/mcp init --hosted --write` flow lands on the brand
// surface without operator plumbing; ATLAS_PUBLIC_API_URL still wins
// for cross-region overrides and self-hosted targets.
const DEFAULT_HOSTED_API_URL = "https://mcp.useatlas.dev";

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
  /** Override the hosted Atlas API base. Defaults to `https://mcp.useatlas.dev`. */
  apiUrl?: string;
  client?: McpClientId;
  write?: boolean;
  /** Override the resolved config file path (test seam). */
  configPathOverride?: string;
  /** Process env (test seam). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seams — passthrough to the hosted flow. */
  fetchImpl?: typeof fetch;
  serveImpl?: ServeImpl;
  openBrowserImpl?: OpenBrowserImpl;
  randomBytesImpl?: (length: number) => Uint8Array;
  callbackTimeoutMs?: number;
  detectClientsImpl?: () => ClientInfo[];
}

export type RunInitOptions = LocalInitOptions | HostedInitOptions;

export interface RunInitResult {
  exitCode: number;
}

export async function runInit(options: RunInitOptions): Promise<RunInitResult> {
  if (options.mode === "hosted") {
    return runHosted(options);
  }
  return runLocal(options);
}

async function runHosted(opts: HostedInitOptions): Promise<RunInitResult> {
  const env = opts.env ?? process.env;
  const apiUrl = opts.apiUrl ?? env.ATLAS_PUBLIC_API_URL ?? DEFAULT_HOSTED_API_URL;

  let result;
  try {
    const flowOpts: HostedFlowOptions = {
      apiUrl,
      fetchImpl: opts.fetchImpl,
      serveImpl: opts.serveImpl,
      openBrowserImpl: opts.openBrowserImpl,
      randomBytesImpl: opts.randomBytesImpl,
      callbackTimeoutMs: opts.callbackTimeoutMs,
    };
    result = await runHostedAuthFlow(flowOpts);
  } catch (err) {
    if (err instanceof HostedFlowError) {
      console.error(`[atlas-mcp init --hosted] ${err.message}`);
      return { exitCode: 1 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp init --hosted] Unexpected error: ${msg}`);
    return { exitCode: 1 };
  }

  const serverCfg = buildHostedServerConfig({
    url: result.mcpUrl,
    accessToken: result.accessToken,
  });
  const clientId = opts.client ?? pickDefaultClient(opts.detectClientsImpl);
  const configPath = opts.configPathOverride ?? getDefaultConfigPath(clientId);

  console.log(`Authorized for workspace ${result.workspaceId} at ${apiUrl}.`);

  if (!opts.write || configPath === null) {
    printPasteSnippet(clientId, serverCfg, configPath);
    if (result.refreshToken) {
      console.log(
        "# A refresh token was issued. Atlas's MCP clients re-authenticate transparently — keep this config file at mode 0600.",
      );
    }
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp init] failed to write ${configPath}: ${msg}`);
    if (existing !== null) {
      console.error("Your existing config was not modified — the new content was staged in a sibling tmp file and the rename never happened.");
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp init] failed to write ${configPath}: ${msg}`);
    if (existing !== null) {
      console.error("Your existing config was not modified — the new content was staged in a sibling tmp file and the rename never happened.");
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
