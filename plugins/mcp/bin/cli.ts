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
import { runInit, type RunInitOptions } from "../src/init/index.js";
import { KNOWN_CLIENTS, type McpClientId } from "../src/init/clients.js";

const KNOWN_CLIENT_IDS: readonly string[] = KNOWN_CLIENTS.map((c) => c.id);

interface InitFlags {
  mode: "local" | "hosted";
  client: McpClientId | undefined;
  write: boolean;
  apiUrl: string | undefined;
  help: boolean;
}

function parseInitArgs(argv: string[]): InitFlags {
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
          console.error(
            `[atlas-mcp init] --client expects one of: ${KNOWN_CLIENT_IDS.join(", ")}`,
          );
          process.exit(1);
        }
        flags.client = next as McpClientId;
        i++;
        break;
      }
      case "--api-url": {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          console.error(
            `[atlas-mcp init] --api-url expects a URL value (e.g. http://localhost:3001)`,
          );
          process.exit(1);
        }
        flags.apiUrl = next;
        i++;
        break;
      }
      default:
        console.error(`[atlas-mcp init] Unknown flag: ${a}`);
        process.exit(1);
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

async function runInitCommand(argv: string[]): Promise<number> {
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

interface ServeFlags {
  transport: "stdio" | "sse";
  port: number;
}

function parseServeArgs(argv: string[]): ServeFlags {
  const flags: ServeFlags = { transport: "stdio", port: 8080 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transport" && argv[i + 1]) {
      const value = argv[i + 1];
      if (value !== "stdio" && value !== "sse") {
        console.error(`[atlas-mcp serve] Unknown transport: "${value}". Use "stdio" or "sse".`);
        process.exit(1);
      }
      flags.transport = value;
      i++;
    } else if (a === "--port" && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (isNaN(parsed) || parsed <= 0) {
        console.error(`[atlas-mcp serve] Invalid port: "${argv[i + 1]}". Must be a positive integer.`);
        process.exit(1);
      }
      flags.port = parsed;
      i++;
    } else {
      console.error(`[atlas-mcp serve] Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return flags;
}

async function runServeCommand(argv: string[]): Promise<number> {
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
  let createAtlasMcpServer: (opts?: { transport?: "stdio" | "sse" }) => Promise<{
    connect(t: unknown): Promise<void>;
    close(): Promise<void>;
  }>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import target is private workspace package; resolution is best-effort
    const mod = (await import("@atlas/mcp/server")) as any;
    createAtlasMcpServer = mod.createAtlasMcpServer;
  } catch (err) {
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

  if (flags.transport === "sse") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see note on createAtlasMcpServer above
    const sseMod = (await import("@atlas/mcp/sse")) as any;
    const handle = await sseMod.startSseServer(
      () => createAtlasMcpServer({ transport: "sse" }),
      { port: flags.port },
    );
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await handle.close();
      } catch (err) {
        console.error(`[atlas-mcp serve] Error closing SSE server: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.error(`[atlas-mcp serve] SSE server running on http://${handle.server.hostname}:${handle.server.port}/mcp`);
    return 0;
  }

  const server = await createAtlasMcpServer({ transport: "stdio" });
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (err) {
      console.error(`[atlas-mcp serve] Error closing server: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Log to stderr so it doesn't interfere with JSON-RPC on stdout
  console.error("[atlas-mcp serve] Server running on stdio");
  return 0;
}

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    console.log(TOP_HELP);
    return subcommand ? 0 : 1;
  }

  switch (subcommand) {
    case "init":
      return runInitCommand(rest);
    case "serve":
      return runServeCommand(rest);
    default:
      console.error(`[atlas-mcp] Unknown command: ${subcommand}`);
      console.error(TOP_HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp] Fatal: ${msg}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
