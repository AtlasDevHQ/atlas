#!/usr/bin/env bun
/**
 * `bunx @useatlas/mcp init` entry point. Generates a paste-ready Claude
 * Desktop / Cursor / Continue config; with `--write`, merges into the
 * detected client's config file (timestamped `.bak` backup).
 */

import { runInit, type RunInitOptions } from "../src/init/index.js";
import { KNOWN_CLIENTS, type McpClientId } from "../src/init/clients.js";

const KNOWN_CLIENT_IDS: readonly string[] = KNOWN_CLIENTS.map((c) => c.id);

interface CliFlags {
  mode: "local" | "hosted";
  client: McpClientId | undefined;
  write: boolean;
  apiUrl: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
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
          console.error(`[atlas-mcp init] --api-url expects a URL value (e.g. http://localhost:3001)`);
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

const HELP = `bunx @useatlas/mcp init [options]

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

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
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

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[atlas-mcp init] Fatal: ${msg}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
