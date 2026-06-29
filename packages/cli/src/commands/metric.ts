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

import { renderTable } from "../../lib/output";
import { resolveApiBaseUrl } from "../lib/api-base";
import { readSession, type StoredSession } from "../lib/credentials";
import {
  MetricCliError,
  runMetric,
  type MetricClientOptions,
  type MetricRunResult,
} from "../lib/metric-client";

const USAGE = `Run a canonical metric against your logged-in workspace.

Usage: atlas metric run <id> [--connection <id>] [--json]

Arguments:
  <id>                The metric id from semantic/metrics/*.yml

Options:
  --connection <id>   Run against a specific datasource in the metric's group
  --json              Machine-readable JSON output

The metric's SQL is used exactly as defined (authoritative). Group routing is
honored — a grouped metric runs against its own group's datasource.
Requires \`atlas login\` first. Set ATLAS_API_URL to target a non-local API.`;

/** stdout/stderr sink — injected so tests can capture output. */
export interface MetricIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIO: MetricIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Everything `runMetricCommand` needs, injected so it stays server-free in tests. */
export interface MetricRunDeps {
  readonly baseUrl: string;
  readonly session: StoredSession | null;
  readonly fetchImpl?: typeof fetch;
}

/** Read a `--flag value` option from argv, or undefined when absent. */
function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
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
  io: MetricIO = defaultIO,
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

  // The metric id is the first non-flag positional after `run`.
  const id = args.slice(2).find((a) => !a.startsWith("--"));
  if (!id) {
    io.err("Usage: atlas metric run <id> [--connection <id>] [--json]");
    return 1;
  }

  if (!deps.session) {
    io.err("Not logged in. Run `atlas login` first.");
    return 1;
  }

  const json = args.includes("--json");
  const connectionId = getFlagValue(args, "--connection");

  const opts: MetricClientOptions = {
    baseUrl: deps.baseUrl,
    token: deps.session.token,
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

/** Thin shell main() invokes: resolve the credential + base URL, then dispatch. */
export async function handleMetric(args: string[]): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  const code = await runMetricCommand(args, { baseUrl, session });
  if (code !== 0) process.exit(code);
}
