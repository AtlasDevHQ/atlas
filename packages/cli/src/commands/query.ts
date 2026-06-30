/**
 * atlas query — Ask a natural language question via the Atlas API.
 *
 * The NL happy path (Shape A): the caller asks a question, Atlas's server-side
 * LLM writes + runs the SQL and returns a narrative answer. `atlas sql` is the
 * advanced raw-SQL surface (Shape B).
 *
 * Authorization rides on the SAME workspace credential as `sql`/`datasource`/
 * `explore` (#4112 / ADR-0027 §5): the `atlas login` device-flow SESSION bearer
 * (sent as `Authorization: Bearer`) for interactive use, OR a workspace-scoped
 * API key for unattended CI (`--api-key` / `ATLAS_API_KEY`, sent as `x-api-key`
 * — the Better Auth `apiKey()` plugin's header, NOT `Authorization: Bearer`).
 * The credential resolution is single-sourced through `lib/credential` so
 * `query` can't drift from the other REST-backed subcommands (#4124).
 *
 * The dispatch + rendering live in the testable `runQueryCommand` core (the
 * session, the API base URL, the api-key, and `fetch` are injected), so credential
 * resolution, request shape, and output are unit-tested without a live server or
 * `process.exit`. `handleQuery` is the thin shell main() calls.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { getFlag } from "../../lib/cli-utils";
import {
  formatCsvValue,
  quoteCsvField,
  renderTable,
} from "../../lib/output";
import { resolveApiBaseUrl } from "../lib/api-base";
import {
  readApiKeyFlag,
  resolveCredential,
  credentialHeaders,
  type CliCredential,
} from "../lib/credential";
import { readSession, type StoredSession } from "../lib/credentials";

// --- Types ---

/** Response shape from POST /api/v1/query */
interface QueryAPIResponse {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  pendingActions?: {
    id: string;
    type: string;
    target: string;
    summary: string;
    approveUrl: string;
    denyUrl: string;
  }[];
}

/** Response shape for API errors */
interface QueryAPIError {
  error: string;
  message: string;
}

/** stdout/stderr sink — injected so tests can capture output (mirrors `sql.ts`). */
export interface QueryIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIO: QueryIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Everything `runQueryCommand` needs, injected so it stays server-free in tests. */
export interface QueryRunDeps {
  readonly baseUrl: string;
  readonly session: StoredSession | null;
  /**
   * A workspace-scoped API key for unattended CI (#4046), resolved from the
   * `--api-key` flag or the `ATLAS_API_KEY` env var. When present it takes
   * precedence over the stored session — CI never goes through `atlas login`.
   */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

// --- Action approval ---

/**
 * Call the approve or deny endpoint for a pending action, authorized by the
 * same workspace credential the query ran under (session bearer XOR API key —
 * the latter rides `x-api-key`, never `Authorization: Bearer`).
 *
 * Returns { ok: true, status } on success, { ok: false, error } on failure.
 */
export async function handleActionApproval(
  url: string,
  credential?: CliCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(credential ? credentialHeaders(credential) : {}),
  };

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => {
        // intentionally ignored: error response may not be JSON; fall back to status code
        return {};
      })) as Record<string, unknown>;
      return {
        ok: false,
        error: (body.message as string) ?? `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: true, status: body.status as string };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      return {
        ok: false,
        error:
          "Request timed out after 30s. The action may still be processing -- check its status.",
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Testable core ---

/**
 * Testable core: dispatch one `atlas query` invocation. Returns the process exit
 * code (0 success, 1 failure) without calling `process.exit`, so tests can assert
 * on it directly (mirrors `runSqlCommand`).
 *
 * `args` is the full argv slice (args[0] === "query").
 */
export async function runQueryCommand(
  args: string[],
  deps: QueryRunDeps,
  io: QueryIO = defaultIO,
): Promise<number> {
  // The question is the first positional after "query" that isn't a flag and
  // isn't the value consumed by a value-taking flag (`--connection <id>`,
  // `--api-key <key>`). The inline forms (`--connection=x`, `--api-key=x`) start
  // with `--`, so they're skipped by the flag check.
  const question = args.find((a, i) => {
    if (i === 0 || a.startsWith("--")) return false;
    const prev = args[i - 1];
    if (prev === "--connection" || prev === "--api-key") return false;
    return true;
  });

  if (!question) {
    io.err(
      'Usage: atlas query "your question" [options]\n\n' +
        "Options:\n" +
        "  --json               Raw JSON output (pipe-friendly)\n" +
        "  --csv                CSV output (headers + rows only)\n" +
        "  --quiet              Data only -- no narrative, SQL, or stats\n" +
        "  --auto-approve       Auto-approve any pending actions\n" +
        "  --connection <id>    Query a specific datasource\n" +
        "  --api-key <key>      Use a workspace API key instead of your `atlas login` session\n\n" +
        "Authentication:\n" +
        "  `atlas login` for interactive use (ambient session reuse -- no key needed),\n" +
        "  OR a workspace API key via --api-key / ATLAS_API_KEY for unattended CI.\n\n" +
        "Environment:\n" +
        "  ATLAS_API_URL        API server URL (default: http://localhost:3001)\n" +
        "  ATLAS_API_KEY        Workspace API key for unattended authentication\n\n" +
        "Examples:\n" +
        '  atlas query "top 5 customers by revenue"\n' +
        '  atlas query "monthly GMV trend" --json\n' +
        '  atlas query "count of orders" --csv\n' +
        '  atlas query "top categories" --connection warehouse',
    );
    return 1;
  }

  const jsonOutput = args.includes("--json");
  const csvOutput = args.includes("--csv");
  const quietOutput = args.includes("--quiet");
  const autoApprove = args.includes("--auto-approve");
  const connectionId = getFlag(args, "--connection");

  if (jsonOutput && csvOutput) {
    io.err("Error: --json and --csv are mutually exclusive.");
    return 1;
  }

  // Resolve the workspace credential exactly like `sql`/`datasource`: a key
  // (the `--api-key` flag, else `ATLAS_API_KEY`) wins over the stored login.
  // A key rides `x-api-key`; a session bearer rides `Authorization: Bearer`.
  const apiKey = readApiKeyFlag(args) ?? deps.apiKey;
  const credential = resolveCredential(apiKey, deps.session);
  if (!credential) {
    io.err(
      "Not logged in. Run `atlas login` first, or set ATLAS_API_KEY for unattended use.",
    );
    return 1;
  }

  const apiUrl = deps.baseUrl.replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...credentialHeaders(credential),
  };

  const body = { question, ...(connectionId && { connectionId }) };

  // Call the API
  if (!jsonOutput && !csvOutput) io.err("Thinking...");

  let res: Response;
  try {
    res = await fetchImpl(`${apiUrl}/api/v1/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) {
      io.err("Error: Request timed out after 120 seconds.");
      io.err(
        "  The query may be too complex, or the server may be overloaded.",
      );
    } else if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      io.err(`Error: Cannot connect to Atlas API at ${apiUrl}`);
      io.err("  Is the server running? Start it with: bun run dev:api");
    } else {
      io.err(`Error: ${msg}`);
    }
    return 1;
  }

  // Handle HTTP errors
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let errorCode: string | undefined;
    try {
      const errorBody = (await res.json()) as QueryAPIError;
      if (errorBody.message) message = errorBody.message;
      errorCode = errorBody.error;
    } catch {
      try {
        const text = await res.text();
        if (text.length > 0 && text.length < 500)
          message = `HTTP ${res.status}: ${text.trim()}`;
      } catch {
        // Body unreadable -- use HTTP status fallback
      }
    }

    if (res.status === 401 || res.status === 403) {
      io.err(`Error: Authentication failed -- ${message}`);
      io.err(
        "  Run `atlas login`, or set ATLAS_API_KEY to a valid workspace API key.",
      );
    } else if (res.status === 429) {
      io.err(`Error: Rate limit exceeded -- ${message}`);
    } else if (errorCode === "no_datasource") {
      io.err(`Error: ${message}`);
      io.err(
        "  No datasource is available for this workspace. Add one in the Atlas console, or set ATLAS_DATASOURCE_URL on a self-hosted server.",
      );
    } else if (errorCode === "configuration_error") {
      io.err(`Error: Server configuration problem -- ${message}`);
    } else {
      io.err(`Error: ${message}`);
    }
    return 1;
  }

  let data: QueryAPIResponse;
  try {
    data = (await res.json()) as QueryAPIResponse;
  } catch {
    io.err("Error: Failed to parse API response as JSON.");
    io.err(
      `  The server at ${apiUrl} returned a 200 status but the body was not valid JSON.`,
    );
    return 1;
  }

  // Runtime validation of response shape
  if (!Array.isArray(data.data)) {
    io.err(
      "Error: Unexpected API response -- the server may be running a different version.",
    );
    if (data.answer) io.out(`\n${data.answer}`);
    return 1;
  }
  if (!Array.isArray(data.sql)) data.sql = [];
  if (!data.usage || typeof data.usage.totalTokens !== "number") {
    data.usage = { totalTokens: 0 };
  }

  // --- JSON output: print raw response and exit ---
  if (jsonOutput) {
    io.out(JSON.stringify(data, null, 2));
    return 0;
  }

  // --- CSV output: headers + rows, no narrative ---
  if (csvOutput) {
    for (const dataset of data.data) {
      io.out(dataset.columns.map(quoteCsvField).join(","));
      for (const row of dataset.rows) {
        const cells = dataset.columns.map((col) =>
          quoteCsvField(formatCsvValue(row[col])),
        );
        io.out(cells.join(","));
      }
    }
    return 0;
  }

  // --- Table output (default) ---

  // Narrative answer
  if (!quietOutput && data.answer) {
    io.out(`\n${data.answer}\n`);
  }

  // Data tables
  for (const dataset of data.data) {
    if (dataset.columns.length > 0 && dataset.rows.length > 0) {
      io.out(renderTable(dataset.columns, dataset.rows));
      io.out("");
    }
  }

  // Footer: SQL + stats
  if (!quietOutput) {
    if (data.sql.length > 0) {
      io.out(pc.dim(`SQL: ${data.sql[data.sql.length - 1]}`));
    }
    const tokens =
      typeof data.usage?.totalTokens === "number"
        ? data.usage.totalTokens.toLocaleString()
        : "n/a";
    io.out(pc.dim(`Steps: ${data.steps ?? "?"} | Tokens: ${tokens}`));
  }

  // --- Handle pending actions ---
  if (data.pendingActions?.length) {
    io.out("");
    io.out(
      pc.yellow(`${data.pendingActions.length} action(s) require approval:`),
    );

    if (autoApprove) {
      // Auto-approve all pending actions
      for (const action of data.pendingActions) {
        io.err(`  Approving: ${action.summary}... `);
        const result = await handleActionApproval(
          action.approveUrl,
          credential,
          fetchImpl,
        );
        if (result.ok) {
          io.err(pc.green(`${result.status ?? "approved"}`));
        } else {
          io.err(pc.red(`failed: ${result.error}`));
        }
      }
    } else if (process.stdout.isTTY) {
      // Interactive TTY mode -- prompt per action
      for (const action of data.pendingActions) {
        io.out(`\n  ${pc.bold(action.type)}: ${action.summary}`);
        if (action.target) io.out(`  Target: ${action.target}`);

        const choice = await p.select({
          message: "What would you like to do?",
          options: [
            { value: "approve", label: "Approve" },
            { value: "deny", label: "Deny" },
            { value: "skip", label: "Skip (decide later)" },
          ],
        });

        if (p.isCancel(choice) || choice === "skip") {
          io.out(pc.dim(`  Skipped. Approve/deny later:`));
          io.out(pc.dim(`    Approve: curl -X POST ${action.approveUrl}`));
          io.out(pc.dim(`    Deny:    curl -X POST ${action.denyUrl}`));
          continue;
        }

        const url =
          choice === "approve" ? action.approveUrl : action.denyUrl;
        const result = await handleActionApproval(url, credential, fetchImpl);
        if (result.ok) {
          io.out(pc.green(`  Action ${result.status ?? choice}d.`));
        } else {
          io.out(pc.red(`  Failed: ${result.error}`));
        }
      }
    } else {
      // Non-TTY, no --auto-approve -- print URLs and exit
      for (const action of data.pendingActions) {
        io.out(`\n  ${action.type}: ${action.summary}`);
        io.out(`    Approve: ${action.approveUrl}`);
        io.out(`    Deny:    ${action.denyUrl}`);
      }
    }
  }

  return 0;
}

// --- Main handler ---

/** Thin shell main() invokes: resolve the credential inputs + base URL, dispatch. */
export async function handleQuery(args: string[]): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  // ATLAS_API_KEY (#4046) is the unattended-CI credential — NOT persisted to
  // ~/.atlas/credentials. `--api-key` (parsed in runQueryCommand) overrides it.
  const apiKey = process.env.ATLAS_API_KEY?.trim() || undefined;
  const code = await runQueryCommand(args, {
    baseUrl,
    session,
    ...(apiKey ? { apiKey } : {}),
  });
  if (code !== 0) process.exit(code);
}
