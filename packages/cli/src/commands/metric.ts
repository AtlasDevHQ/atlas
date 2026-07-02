/**
 * `atlas metric run <id>` (#4048 / ADR-0027 shared gate-parity contract).
 *
 * The workspace CLI surface for executing a canonical metric — a thin HTTP
 * client over the EXISTING metric-run REST route (`metric-client.ts`),
 * authorized entirely by the `atlas login` workspace credential. It runs the
 * metric's authoritative SQL (used exactly as defined) against ONLY the bound
 * workspace (the bearer resolves live to `{ orgId, role }`), clearing the same
 * gate chain (billing → whitelist → RLS → auto-LIMIT) as the agent loop, and is
 * audited `origin=cli`.
 *
 * Parity reference: the MCP `runMetric` tool (`packages/mcp/src/semantic-tools.ts`).
 * Both reach the same shared metric-execution facade; the difference is only the
 * transport + credential.
 *
 * The dispatch + rendering live in the testable `runMetricCommand` core (deps
 * are injected: the session, the API base URL, and `fetch`), so route mapping,
 * output, and the typed-error → message mapping are unit-tested without a live
 * server or `process.exit`. `handleMetric` is the thin shell main() calls.
 */

import { getFlag } from "../../lib/cli-utils";
import { renderTable } from "../../lib/output";
import { resolveWorkspaceCredential } from "../lib/credential";
import {
  MetricCliError,
  runMetric,
  type MetricClientOptions,
  type MetricRunResult,
} from "../lib/metric-client";
import {
  defaultCliIO,
  runWorkspaceCommand,
  type CliIO,
  type WorkspaceCommandDeps,
} from "../lib/workspace-command";

const USAGE = `Run a canonical metric against your logged-in workspace.

Usage: atlas metric run <id> [--connection <id>] [--json]

Arguments:
  <id>                The metric id from semantic/metrics/*.yml

Options:
  --connection <id>   Run against a specific datasource in the metric's group
  --api-key <key>     Use a workspace API key instead of your \`atlas login\` session
                      (unattended CI). Overrides ATLAS_API_KEY.
  --json              Machine-readable JSON output

The metric's SQL is used exactly as defined (authoritative). Group routing is
honored — a grouped metric runs against its own group's datasource.

Authentication: \`atlas login\` for interactive use (ambient session reuse — no
key needed), OR a workspace API key via --api-key / ATLAS_API_KEY for unattended
CI. Set ATLAS_API_URL to target a non-local API.`;

/** stdout/stderr sink — the shared {@link CliIO}, injected so tests can capture output. */
export type MetricIO = CliIO;

/** Everything `runMetricCommand` needs — the shared {@link WorkspaceCommandDeps}. */
export type MetricRunDeps = WorkspaceCommandDeps;

/** Flags whose following token is a value, not the metric id positional. */
const METRIC_VALUE_FLAGS = new Set(["--connection", "--api-key"]);

/**
 * The metric id: the first non-flag positional after `run`, skipping any token
 * consumed by a value-taking flag (`--connection <id>`, `--api-key <key>`) so a
 * flag's value can never be mistaken for the id.
 */
function findMetricId(args: string[]): string | undefined {
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (METRIC_VALUE_FLAGS.has(a)) {
      i++; // skip the value token this flag consumes
      continue;
    }
    if (a.startsWith("--")) continue;
    return a;
  }
  return undefined;
}

/** Render a metric result for humans: scalar inline, or a table for rows. */
function renderResult(io: MetricIO, result: MetricRunResult): void {
  const labelPart = result.label ? `${result.label} (${result.id})` : result.id;

  // Scalar result (single column / single row) — print the value inline.
  if (result.columns.length === 1 && result.rows.length === 1) {
    io.out(`${labelPart}: ${String(result.value)}`);
    return;
  }

  // Empty result.
  if (result.rows.length === 0) {
    io.out(`${labelPart}: (no rows)`);
    return;
  }

  // Breakdown / multi-row — render a table.
  io.out(`${labelPart}:`);
  io.out(renderTable(result.columns, result.rows));
  if (result.truncated) {
    io.out("(results truncated by the row limit)");
  }
}

/**
 * Testable core: dispatch one `atlas metric` invocation. Returns the process
 * exit code (0 success, 1 failure) without calling `process.exit`, so tests can
 * assert on it directly.
 *
 * `args` is the full argv slice (args[0] === "metric").
 */
export async function runMetricCommand(
  args: string[],
  deps: MetricRunDeps,
  io: MetricIO = defaultCliIO,
): Promise<number> {
  const subcommand = args[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    io.out(USAGE);
    return subcommand ? 0 : 1;
  }

  if (subcommand !== "run") {
    io.err(`Unknown metric command: ${subcommand}\n`);
    io.out(USAGE);
    return 1;
  }

  // The metric id is the first non-flag positional after `run` (skipping any
  // value consumed by `--connection`/`--api-key`).
  const id = findMetricId(args);
  if (!id) {
    io.err("Usage: atlas metric run <id> [--connection <id>] [--api-key <key>] [--json]");
    return 1;
  }

  // A workspace API key (#4046, unattended CI) takes precedence over a stored
  // login; the flag (either `--api-key key` or `--api-key=key`) wins over the env
  // var (deps.apiKey) so an interactive override is possible. Keys are
  // workspace-pinned, so no rebind is needed. The shared resolver emits the
  // "log in or set ATLAS_API_KEY" copy on `io.err` when neither is present.
  const credential = resolveWorkspaceCredential(args, deps, io);
  if (!credential) return 1;

  const json = args.includes("--json");
  const connectionId = getFlag(args, "--connection");

  const opts: MetricClientOptions = {
    baseUrl: deps.baseUrl,
    credential,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };

  try {
    const result = await runMetric(opts, {
      id,
      ...(connectionId ? { connectionId } : {}),
    });
    if (json) {
      io.out(JSON.stringify(result, null, 2));
    } else {
      renderResult(io, result);
    }
    return 0;
  } catch (err) {
    if (err instanceof MetricCliError) {
      io.err(err.message);
      return 1;
    }
    // Unexpected — surface it rather than swallowing (no silent failures).
    io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Thin shell main() invokes: the shared workspace-command shell dispatches the core. */
export async function handleMetric(args: string[]): Promise<void> {
  return runWorkspaceCommand(args, runMetricCommand);
}
