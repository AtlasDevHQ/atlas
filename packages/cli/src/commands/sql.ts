/**
 * `atlas sql "SELECT ..."` (#4047 / ADR-0027).
 *
 * The workspace CLI surface for running ONE caller-authored SELECT — a thin HTTP
 * client over the raw-SQL REST route (`sql-client.ts` → `POST
 * /api/v1/execute-sql`), authorized entirely by the `atlas login` workspace
 * credential. The server is the SOLE security boundary: it runs the SQL through
 * the same 4-layer validation pipeline (regex → AST single-SELECT → table
 * whitelist) + RLS + auto-LIMIT + statement timeout + read-only connection as the
 * agent loop, gated by billing solvency, and audited `origin=cli`. The CLI
 * re-derives none of that and never sends an org/workspace field — workspace
 * isolation derives from the credential (ADR-0027 §5).
 *
 * This is Shape B (raw SQL), the ADVANCED surface. The NL happy path is
 * `atlas query "<question>"` (Atlas's server-side LLM writes the SQL); raw SQL is
 * for callers who already have the exact query.
 *
 * Parity reference: the MCP `executeSQL` tool. Both reach the same shared
 * `runUserQueryPipeline`; the difference is only the transport + credential.
 *
 * The dispatch + rendering live in the testable `runSqlCommand` core (deps are
 * injected: the session, the API base URL, and `fetch`), so route mapping,
 * output, and the typed-error → message mapping are unit-tested without a live
 * server or `process.exit`. `handleSql` is the thin shell main() calls.
 */

import { getFlag } from "../../lib/cli-utils";
import { formatCsvValue, quoteCsvField, renderTable } from "../../lib/output";
import { readApiKeyFlag, NOT_LOGGED_IN_MESSAGE } from "../lib/credential";
import { resolveActiveWorkspace, formatWorkspaceError } from "../lib/workspaces";
import {
  SqlCliError,
  runSql,
  type SqlClientOptions,
  type SqlRunResult,
} from "../lib/sql-client";
import {
  defaultCliIO,
  runWorkspaceCommand,
  type CliIO,
  type WorkspaceCommandDeps,
} from "../lib/workspace-command";

const USAGE = `Run a single validated SELECT against your logged-in workspace.

Usage: atlas sql "SELECT ..." [--connection <id>] [--workspace <id>] [--json | --csv]

Arguments:
  "SELECT ..."        One read-only SELECT statement (quote it for your shell)

Options:
  --connection <id>   Run against a specific datasource (default: the workspace's default)
  --workspace <id>    Act on a specific workspace for this command only
                      (does not change your saved default; use \`atlas switch\`).
                      Interactive logins only — API keys are workspace-pinned.
  --api-key <key>     Use a workspace API key instead of your \`atlas login\` session
                      (unattended CI). Overrides ATLAS_API_KEY.
  --json              Machine-readable JSON output
  --csv               CSV output (headers + rows, pipe-friendly)

The query runs through the same validation pipeline as the agent (4-layer
validation → table whitelist → RLS → auto-LIMIT → statement timeout) against a
read-only connection. DML/DDL, multi-statement, non-whitelisted-table, and
unparseable SQL are rejected. This is the advanced surface — prefer
\`atlas query "<question>"\` for natural-language questions.

Authentication: \`atlas login\` for interactive use (ambient session reuse — no
key needed), OR a workspace API key via --api-key / ATLAS_API_KEY for unattended
CI. Set ATLAS_API_URL to target a non-local API.`;

/** stdout/stderr sink — the shared {@link CliIO}, injected so tests can capture output. */
export type SqlIO = CliIO;

/** Everything `runSqlCommand` needs — the shared {@link WorkspaceCommandDeps}. */
export type SqlRunDeps = WorkspaceCommandDeps;

/** Render a result as CSV (headers + rows), pipe-friendly. */
function renderCsv(io: SqlIO, result: SqlRunResult): void {
  io.out(result.columns.map(quoteCsvField).join(","));
  for (const row of result.rows) {
    io.out(result.columns.map((col) => quoteCsvField(formatCsvValue(row[col]))).join(","));
  }
}

/** Render a result for humans: a table, or an empty-result note. */
function renderResult(io: SqlIO, result: SqlRunResult): void {
  if (result.rows.length === 0) {
    io.out("(no rows)");
    return;
  }
  io.out(renderTable(result.columns, result.rows));
  if (result.truncated) {
    io.out("(results truncated by the row limit)");
  }
}

/**
 * Testable core: dispatch one `atlas sql` invocation. Returns the process exit
 * code (0 success, 1 failure) without calling `process.exit`, so tests can
 * assert on it directly.
 *
 * `args` is the full argv slice (args[0] === "sql").
 */
export async function runSqlCommand(
  args: string[],
  deps: SqlRunDeps,
  io: SqlIO = defaultCliIO,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }

  const json = args.includes("--json");
  const csv = args.includes("--csv");
  if (json && csv) {
    io.err("Error: --json and --csv are mutually exclusive.");
    return 1;
  }

  const connectionId = getFlag(args, "--connection");

  // The SQL is the first positional after `sql` that isn't a flag and isn't the
  // value consumed by a value-taking flag (`--connection <id>`, `--workspace <id>`,
  // `--api-key <key>`). `--workspace` is parsed inside resolveActiveWorkspace
  // (supports the inline `--workspace=<id>` form too), so only the space-separated
  // value is skipped here.
  const rest = args.slice(1);
  const sql = rest.find((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = rest[i - 1];
    if (prev === "--connection" || prev === "--workspace" || prev === "--api-key") return false;
    return true;
  });

  if (!sql) {
    io.err('Usage: atlas sql "SELECT ..." [--connection <id>] [--workspace <id>] [--json | --csv]');
    return 1;
  }

  // A workspace API key (#4046, unattended CI) takes precedence over a stored
  // login. The flag (either `--api-key key` or `--api-key=key`) wins over the env
  // var so an interactive override is possible.
  const apiKey = readApiKeyFlag(args) ?? deps.apiKey;
  // `--workspace` in EITHER form — space (`--workspace x`) or inline
  // (`--workspace=x`). `resolveActiveWorkspace` accepts both, so the api-key
  // guard below must reject both; a space-only check would let `--workspace=x`
  // slip past and be silently ignored.
  const hasWorkspaceFlag = args.some((a) => a === "--workspace" || a.startsWith("--workspace="));

  if (apiKey) {
    // The key is pinned to its workspace by its server-side metadata, so a
    // `--workspace` override is meaningless (and a session rebind would need a
    // session bearer the key doesn't carry). Reject it loudly rather than
    // silently ignore the flag.
    if (hasWorkspaceFlag) {
      io.err(
        "API keys are pinned to one workspace; --workspace only applies to interactive `atlas login` sessions.",
      );
      return 1;
    }

    const opts: SqlClientOptions = {
      baseUrl: deps.baseUrl,
      credential: { apiKey },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
    return runAndRender(opts, sql, connectionId, json, csv, io);
  }

  if (!deps.session) {
    io.err(NOT_LOGGED_IN_MESSAGE);
    return 1;
  }

  // A `--workspace <id>` override rebinds the session to that workspace for this
  // command (membership-gated server-side); without it we use the stored
  // default. We MUST await this before the SQL request so the server has rebound
  // the bearer's active org. A non-member is rejected here, before any query runs.
  try {
    await resolveActiveWorkspace(
      args,
      deps.baseUrl,
      deps.session.token,
      deps.session.workspaceId,
      deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
    );
  } catch (err) {
    io.err(formatWorkspaceError(err));
    return 1;
  }

  const opts: SqlClientOptions = {
    baseUrl: deps.baseUrl,
    credential: { token: deps.session.token },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return runAndRender(opts, sql, connectionId, json, csv, io);
}

/** Run the SQL via the client and render the result / typed error. Shared by the
 * session and api-key credential paths so output handling can't drift. */
async function runAndRender(
  opts: SqlClientOptions,
  sql: string,
  connectionId: string | undefined,
  json: boolean,
  csv: boolean,
  io: SqlIO,
): Promise<number> {
  try {
    const result = await runSql(opts, {
      sql,
      ...(connectionId ? { connectionId } : {}),
    });
    if (json) {
      io.out(JSON.stringify(result, null, 2));
    } else if (csv) {
      renderCsv(io, result);
    } else {
      renderResult(io, result);
    }
    return 0;
  } catch (err) {
    if (err instanceof SqlCliError) {
      io.err(err.message);
      return 1;
    }
    // Unexpected — surface it rather than swallowing (no silent failures).
    io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Thin shell main() invokes: the shared workspace-command shell dispatches the core. */
export async function handleSql(args: string[]): Promise<void> {
  return runWorkspaceCommand(args, runSqlCommand);
}
