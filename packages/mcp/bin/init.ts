#!/usr/bin/env bun
/**
 * `bunx @useatlas/mcp init` entry point.
 *
 * Generates a paste-ready Claude Desktop / Cursor / Continue config for
 * Atlas's MCP server. Pass `--write` to merge into the detected client's
 * config file (with a `.bak` of any previous file).
 *
 * Usage:
 *   bunx @useatlas/mcp init --local
 *   bunx @useatlas/mcp init --local --write
 *   bunx @useatlas/mcp init --local --client cursor --write
 *   bunx @useatlas/mcp init --hosted   # stub — comes with #2024
 *
 * From this monorepo (until @useatlas/mcp ships to npm):
 *   bun packages/mcp/bin/init.ts --local
 */

import { runInit, type RunInitOptions } from "../src/init/index.js";
import type { McpClientId } from "../src/init/clients.js";

const KNOWN_CLIENTS: McpClientId[] = ["claude-desktop", "cursor", "continue", "generic"];

interface CliFlags {
  mode: "local" | "hosted" | null;
  client: McpClientId | undefined;
  write: boolean;
  apiUrl: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    mode: null,
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
      case "--no-write":
        flags.write = false;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--client": {
        const next = argv[i + 1];
        if (!next || !KNOWN_CLIENTS.includes(next as McpClientId)) {
          console.error(
            `[atlas-mcp init] --client expects one of: ${KNOWN_CLIENTS.join(", ")}`,
          );
          process.exit(1);
        }
        flags.client = next as McpClientId;
        i++;
        break;
      }
      case "--api-url":
        flags.apiUrl = argv[i + 1];
        i++;
        break;
      default:
        console.error(`[atlas-mcp init] Unknown flag: ${a}`);
        process.exit(1);
    }
  }

  return flags;
}

const HELP = `bunx @useatlas/mcp init [options]

  --local            Configure for a local Atlas (default if --hosted not set)
  --hosted           Configure for app.useatlas.dev (coming with #2024)
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

  if (flags.mode === null) {
    // Default to --local for now; the auto-detect prompt described in #2018
    // can land alongside --hosted in a follow-up since it depends on the
    // hosted flow.
    flags.mode = "local";
  }

  const opts: RunInitOptions = {
    mode: flags.mode,
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
