#!/usr/bin/env bun
/**
 * Monorepo-only entry point that forwards to `@useatlas/mcp init`.
 *
 * The init code itself lives in `plugins/mcp/src/init/` (the published
 * package) — this file is kept as a thin delegate so existing monorepo
 * shortcuts (`bun packages/mcp/bin/init.ts ...`) and the `atlas-mcp-init`
 * bin entry continue to work. End users should run `bunx @useatlas/mcp init`
 * once the npm package is published (#2042).
 */

import { runInit, type RunInitOptions } from "@useatlas/mcp/init";
import { KNOWN_CLIENTS, type McpClientId } from "@useatlas/mcp/init/clients";

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

const HELP = `bun packages/mcp/bin/init.ts [options]
(monorepo dev shortcut — end users should run \`bunx @useatlas/mcp init\`)

  --local            Configure for a local Atlas (default)
  --hosted           Configure for app.useatlas.dev (not yet available)
  --client <id>      Force a specific client: claude-desktop | cursor | continue | generic
  --write            Merge into the client's config file (with a .bak backup)
  --api-url <url>    Override local Atlas detection URL (default: http://localhost:3001)
  -h, --help         Show this help
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
