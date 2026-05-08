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

/**
 * Cross-workspace prompt outcome (#2073). The CLI offers two choices to
 * users who belong to more than one workspace:
 *   - `single`: pin this agent to the active workspace (legacy behavior)
 *   - `multi`:  configure for cross-workspace use; the user upgrades the
 *               agent to multi-scope in Settings → AI Agents
 *
 * Single-workspace users never see the prompt — the CLI treats it as an
 * implicit `single` choice.
 */
export type WorkspaceChoice = "single" | "multi";

/**
 * Test seam for the interactive prompt. Production callers leave this
 * undefined and the default readline-backed prompt is used; tests pass
 * a stub that immediately resolves with the chosen value.
 */
export type WorkspacePromptImpl = (args: {
  workspaceIds: string[];
  activeWorkspaceId: string;
}) => Promise<WorkspaceChoice>;

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
  /**
   * Override the multi-workspace prompt (test seam). Default uses
   * `node:readline` against process.stdin/stdout. Set to `() => Promise.resolve("single")`
   * for non-interactive scripts; tests typically supply a deterministic stub.
   */
  workspacePromptImpl?: WorkspacePromptImpl;
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

  const isMultiWorkspaceUser = result.workspaceIds.length > 1;
  let workspaceChoice: WorkspaceChoice = "single";
  if (isMultiWorkspaceUser) {
    const promptImpl = opts.workspacePromptImpl ?? defaultWorkspacePrompt;
    workspaceChoice = await promptImpl({
      workspaceIds: result.workspaceIds,
      activeWorkspaceId: result.workspaceId,
    });
  }

  const serverCfg = buildHostedServerConfig({
    url: result.mcpUrl,
    accessToken: result.accessToken,
    // Hint the agent's framework about the default workspace via env;
    // forward-compat for wrappers that bridge env into a header. Today's
    // MCP clients (Claude Desktop, Cursor) ignore the env block on
    // HTTP/SSE configs, but writing it is harmless.
    defaultWorkspaceId:
      workspaceChoice === "multi" ? result.workspaceId : undefined,
  });
  const clientId = opts.client ?? pickDefaultClient(opts.detectClientsImpl);
  const configPath = opts.configPathOverride ?? getDefaultConfigPath(clientId);

  console.log(`Authorized for workspace ${result.workspaceId} at ${apiUrl}.`);
  if (workspaceChoice === "multi") {
    console.log(
      `Multi-workspace mode: this agent will use ${result.workspaceId} by default. ` +
        `Open https://app.useatlas.dev/settings/ai-agents to grant access to your other ` +
        `workspaces (${result.workspaceIds.length - 1} additional).`,
    );
  }

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

/**
 * Default multi-workspace prompt (#2073). Asks via stdin/stdout once the
 * OAuth flow has finished and we know the user belongs to N>1 workspaces.
 *
 * Two choices, not N+1:
 *   1. `single` — pin the agent to the active workspace. URL bakes in
 *      `${activeWorkspaceId}` (today's behavior, no follow-up needed).
 *   2. `multi`  — configure for cross-workspace use; user upgrades the
 *      grant set in Settings → AI Agents.
 *
 * Why not N+1: picking "workspace #2 instead of the active one" requires
 * either re-running OAuth with that workspace active OR a server-side
 * mint-against-other-workspace endpoint. Both are out of scope for the
 * 1.4.1 close-out PR; the two-choice prompt covers the install-once
 * path acceptably and Settings → AI Agents handles the rest.
 *
 * Falls back to `single` on any I/O error (TTY closed mid-prompt, EOF,
 * unparseable input). The CLI never blocks waiting for unreachable
 * input; degrading to the safe default is preferable to a hung process.
 */
const defaultWorkspacePrompt: WorkspacePromptImpl = async ({
  workspaceIds,
  activeWorkspaceId,
}) => {
  // Lazy-import readline so test runs that supply `workspacePromptImpl`
  // don't have to mock stdin/stdout. Same pattern as serve.ts's lazy
  // dynamic imports for transport modules.
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  try {
    console.log("");
    console.log(
      `You belong to ${workspaceIds.length} workspaces. Configure this agent for:`,
    );
    console.log(`  [1] Just ${activeWorkspaceId} (active workspace, default)`);
    console.log(`  [2] All your workspaces (workspace-aware via X-Atlas-Workspace)`);
    const answer = (await question("Choice [1]: ")).trim();
    if (answer === "2") return "multi";
    return "single";
  } catch {
    // intentionally ignored: any prompt failure (closed TTY, EOF) falls
    // back to the safe default. The user can re-run the install or use
    // `--no-prompt` (future flag) to skip non-interactively.
    return "single";
  } finally {
    rl.close();
  }
};
