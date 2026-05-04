#!/usr/bin/env bun
/**
 * Monorepo dev shortcut for `bunx @useatlas/mcp init`. Delegates flag
 * parsing + dispatch to the published package's `runInitCommand` so the
 * argv contract stays in one place; this file exists only so existing
 * monorepo invocations (`bun packages/mcp/bin/init.ts ...`) and the
 * `atlas-mcp-init` bin entry continue to work. End users should run
 * `bunx @useatlas/mcp init` (#2042).
 */

import { runInitCommand, CliUsageError } from "@useatlas/mcp/cli";

runInitCommand(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      process.exit(1);
    }
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[atlas-mcp init] Fatal: ${detail}`);
    process.exit(1);
  });
