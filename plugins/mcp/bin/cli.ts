#!/usr/bin/env bun
/**
 * `bunx @useatlas/mcp` entry point. Dispatches to subcommands:
 *
 *   init   — generate or merge a Claude Desktop / Cursor / Continue config
 *   serve  — start the Atlas MCP server (requires `@atlas/mcp` to be
 *            resolvable from the current working directory)
 *
 * `init` is fully self-contained — it has no @atlas/api or @atlas/mcp
 * dependency, so it works in a transient `bunx` install. `serve` is a thin
 * pass-through that dynamic-imports `@atlas/mcp/server`; if that resolves
 * (monorepo dev or a create-atlas-agent project that bundles the API code)
 * it boots the server, otherwise it prints a clear "not yet supported"
 * message pointing at #2024 (hosted MCP).
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { runInit, type RunInitOptions } from "../src/init/index.js";
import { KNOWN_CLIENTS, type McpClientId } from "../src/init/clients.js";

const KNOWN_CLIENT_IDS: readonly string[] = KNOWN_CLIENTS.map((c) => c.id);

/**
 * Thrown by argv parsers on bad input. `main()` catches it, prints the
 * message to stderr, and returns exit 1. Keeps the parsers as pure
 * functions — testable in-process and recoverable for non-CLI callers.
 */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export interface InitFlags {
  mode: "local" | "hosted";
  client: McpClientId | undefined;
  write: boolean;
  apiUrl: string | undefined;
  help: boolean;
}

export function parseInitArgs(argv: string[]): InitFlags {
  const flags: InitFlags = {
    mode: "local",
    client: undefined,
    write: false,
    apiUrl: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--local":
        flags.mode = "local";
        break;
      case "--hosted":
        flags.mode = "hosted";
        break;
      case "--write":
        flags.write = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--client": {
        const next = argv[i + 1];
        if (!next || !KNOWN_CLIENT_IDS.includes(next)) {
          throw new CliUsageError(
            `[atlas-mcp init] --client expects one of: ${KNOWN_CLIENT_IDS.join(", ")}`,
          );
        }
        flags.client = next as McpClientId;
        i++;
        break;
      }
      case "--api-url": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          throw new CliUsageError(
            `[atlas-mcp init] --api-url expects a URL value (e.g. http://localhost:3001)`,
          );
        }
        flags.apiUrl = next;
        i++;
        break;
      }
      default:
        throw new CliUsageError(`[atlas-mcp init] Unknown flag: ${a}`);
    }
  }

  return flags;
}

const TOP_HELP = `bunx @useatlas/mcp <command> [options]

Commands:
  init     Generate or merge an MCP client config (Claude Desktop, Cursor, Continue)
  serve    Start the Atlas MCP server (stdio or SSE)

Run \`bunx @useatlas/mcp <command> --help\` for command-specific options.
`;

const INIT_HELP = `bunx @useatlas/mcp init [options]

  --local            Configure for a local Atlas (default)
  --hosted           Configure for app.useatlas.dev (not yet available)
  --client <id>      Force a specific client: claude-desktop | cursor | continue | generic
  --write            Merge into the client's config file (with a .bak backup)
  --api-url <url>    Override local Atlas detection URL (default: http://localhost:3001)
  -h, --help         Show this help

Examples:
  bunx @useatlas/mcp init --local
  bunx @useatlas/mcp init --local --write
  bunx @useatlas/mcp init --local --client cursor --write
`;

const SERVE_HELP = `bunx @useatlas/mcp serve [options]

  --transport stdio|sse  Transport (default: stdio)
  --port <n>             Port for sse transport (default: 8080)

The serve command requires \`@atlas/mcp\` to be resolvable from the current
working directory — i.e. you're running it inside a project that includes the
Atlas API source (the create-atlas-agent template, the monorepo, or a custom
deployment). Standalone \`bunx\`-only invocations are tracked in #2024.
`;

export async function runInitCommand(argv: string[]): Promise<number> {
  const flags = parseInitArgs(argv);
  if (flags.help) {
    console.log(INIT_HELP);
    return 0;
  }

  const opts: RunInitOptions =
    flags.mode === "hosted"
      ? { mode: "hosted" }
      : {
          mode: "local",
          client: flags.client,
          write: flags.write,
          apiUrl: flags.apiUrl,
        };
  const { exitCode } = await runInit(opts);
  return exitCode;
}

export interface ServeFlags {
  transport: "stdio" | "sse";
  port: number;
}

export function parseServeArgs(argv: string[]): ServeFlags {
  const flags: ServeFlags = { transport: "stdio", port: 8080 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transport") {
      const next = argv[i + 1];
      if (!next) {
        throw new CliUsageError(`[atlas-mcp serve] --transport expects a value: stdio | sse`);
      }
      if (next !== "stdio" && next !== "sse") {
        throw new CliUsageError(
          `[atlas-mcp serve] Unknown transport: "${next}". Use "stdio" or "sse".`,
        );
      }
      flags.transport = next;
      i++;
    } else if (a === "--port") {
      const next = argv[i + 1];
      if (!next) {
        throw new CliUsageError(`[atlas-mcp serve] --port expects a positive integer (e.g. 8080)`);
      }
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed <= 0) {
        throw new CliUsageError(
          `[atlas-mcp serve] Invalid port: "${next}". Must be a positive integer.`,
        );
      }
      flags.port = parsed;
      i++;
    } else {
      throw new CliUsageError(`[atlas-mcp serve] Unknown flag: ${a}`);
    }
  }
  return flags;
}

/**
 * `import()` errors raised when the package itself can't be located. We narrow
 * the catch on `@atlas/mcp/server` to ONLY these so a config bug or
 * downstream module-evaluation error inside `@atlas/api` (e.g. missing
 * `DATABASE_URL`, an Effect Layer construction failure) doesn't get
 * misreported as "package missing — see #2024."
 *
 * Detection strategy: Node sets `err.code === "ERR_MODULE_NOT_FOUND"` /
 * `"MODULE_NOT_FOUND"`. Bun raises a `ResolveMessage` class with a
 * `Cannot find module ...` message but no Node-style `code`. We accept both.
 */
export function isModuleNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  // Bun: ResolveMessage. Match by class name + message shape so we don't
  // need to import the (private) class.
  const ctor = (err as { constructor?: { name?: string } }).constructor;
  if (ctor?.name === "ResolveMessage") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /Cannot find (module|package) /.test(message);
}

interface AtlasMcpServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}
interface CreateMcpServerOptions {
  transport?: "stdio" | "sse";
}
interface ServerModule {
  createAtlasMcpServer: (opts?: CreateMcpServerOptions) => Promise<AtlasMcpServer>;
}
interface SseHandle {
  server: { hostname: string; port: number };
  close(): Promise<void>;
}
interface SseModule {
  startSseServer: (
    factory: () => Promise<AtlasMcpServer>,
    opts: { port: number },
  ) => Promise<SseHandle>;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

export async function runServeCommand(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(SERVE_HELP);
    return 0;
  }

  const flags = parseServeArgs(argv);

  // Dynamic imports — resolve only when the consumer's project includes
  // `@atlas/mcp` (currently the monorepo + create-atlas-agent scaffolds that
  // path-alias the Atlas API source). A transient `bunx` install does NOT
  // include `@atlas/mcp`, so this path intentionally fails with a pointer to
  // #2024 (hosted MCP) rather than pretending to start a broken server.
  let serverMod: ServerModule;
  try {
    // The cast threads the dynamic-import payload through our local
    // interface. We can't import the type statically because `@atlas/mcp`
    // isn't a hard dep of the published package; type-only imports would
    // still demand the .d.ts at consumer build time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
    serverMod = (await import("@atlas/mcp/server")) as any as ServerModule;
  } catch (err) {
    if (!isModuleNotFound(err)) {
      // Not a resolution problem — surface it. The package was found but
      // crashed during evaluation; the original stack is the only hint
      // the user has.
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      [
        "[atlas-mcp serve] Could not resolve `@atlas/mcp` from the current project.",
        "",
        "The serve subcommand currently requires the Atlas API source to be available",
        "in the same project (monorepo dev or a create-atlas-agent scaffold). Standalone",
        "`bunx @useatlas/mcp serve` is tracked in https://github.com/AtlasDevHQ/atlas/issues/2024.",
        "",
        `Details: ${detail}`,
      ].join("\n"),
    );
    return 1;
  }

  // Returns a Promise that only resolves on graceful shutdown. Resolving
  // synchronously here would let `main().then(process.exit)` tear stdio /
  // SSE down before they read a single byte.
  return new Promise<number>((resolve, reject) => {
    let shuttingDown = false;

    if (flags.transport === "sse") {
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see note on serverMod above
        const sseMod = (await import("@atlas/mcp/sse")) as any as SseModule;
        const handle = await sseMod.startSseServer(
          () => serverMod.createAtlasMcpServer({ transport: "sse" }),
          { port: flags.port },
        );
        try {
          const shutdown = async (): Promise<void> => {
            if (shuttingDown) return;
            shuttingDown = true;
            try {
              await handle.close();
              resolve(0);
            } catch (err) {
              console.error(
                `[atlas-mcp serve] Error closing SSE server: ${formatErr(err)}`,
              );
              resolve(1);
            }
          };
          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
          console.error(
            `[atlas-mcp serve] SSE server running on http://${handle.server.hostname}:${handle.server.port}/mcp`,
          );
        } catch (err) {
          // Anything thrown after `startSseServer` resolved (signal-handler
          // setup, console write) leaves a live listener bound to the port.
          // Drain it before rejecting so we don't leak.
          await handle.close().catch((closeErr) => {
            console.error(
              `[atlas-mcp serve] cleanup failed after partial SSE boot: ${formatErr(closeErr)}`,
            );
          });
          throw err;
        }
      })().catch(reject);
      return;
    }

    (async () => {
      const server = await serverMod.createAtlasMcpServer({ transport: "stdio" });
      try {
        const { StdioServerTransport } = await import(
          "@modelcontextprotocol/sdk/server/stdio.js"
        );
        const transport = new StdioServerTransport();
        await server.connect(transport);

        const shutdown = async (): Promise<void> => {
          if (shuttingDown) return;
          shuttingDown = true;
          try {
            await server.close();
            resolve(0);
          } catch (err) {
            console.error(
              `[atlas-mcp serve] Error closing server: ${formatErr(err)}`,
            );
            resolve(1);
          }
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        // Log to stderr so it doesn't interfere with JSON-RPC on stdout
        console.error("[atlas-mcp serve] Server running on stdio");
      } catch (err) {
        // Transport setup or connect() failed AFTER createAtlasMcpServer
        // returned a live server — the caller has lost the reference, so
        // we own the cleanup before propagating.
        await server.close().catch((closeErr) => {
          console.error(
            `[atlas-mcp serve] cleanup failed after partial stdio boot: ${formatErr(closeErr)}`,
          );
        });
        throw err;
      }
    })().catch(reject);
  });
}

export async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    // Bare `bunx @useatlas/mcp` and `--help` are both legitimate discovery
    // flows — exit 0 so `set -e` shells and CI smoke checks don't trip.
    console.log(TOP_HELP);
    return 0;
  }

  try {
    switch (subcommand) {
      case "init":
        return await runInitCommand(rest);
      case "serve":
        return await runServeCommand(rest);
      default:
        console.error(`[atlas-mcp] Unknown command: ${subcommand}`);
        console.error(TOP_HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

// Guard the side-effecting auto-run so test files can `import` from this
// module to mock and exercise specific dispatchers without booting the CLI.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[atlas-mcp] Fatal: ${formatErr(err)}`);
      process.exit(1);
    });
}
