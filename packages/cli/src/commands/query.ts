/**
 * atlas query — Ask a natural language question via the Atlas API.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { getFlag } from "../../lib/cli-utils";
import {
  formatCsvValue,
  quoteCsvField,
  renderTable,
} from "../../lib/output";

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

// --- Action approval ---

/**
 * Call the approve or deny endpoint for a pending action.
 * Returns { ok: true, status } on success, { ok: false, error } on failure.
 */
export async function handleActionApproval(
  url: string,
  apiKey?: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
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

// --- Main handler ---

export async function handleQuery(args: string[]): Promise<void> {
  // Parse the question -- first positional arg after "query"
  const question = args.find(
    (a, i) =>
      i > 0 &&
      !a.startsWith("--") &&
      (i === 1 || args[i - 1] !== "--connection"),
  );

  if (!question) {
    console.error(
      'Usage: atlas query "your question" [options]\n\n' +
        "Options:\n" +
        "  --json               Raw JSON output (pipe-friendly)\n" +
        "  --csv                CSV output (headers + rows only)\n" +
        "  --quiet              Data only -- no narrative, SQL, or stats\n" +
        "  --auto-approve       Auto-approve any pending actions\n" +
        "  --connection <id>    Query a specific datasource\n\n" +
        "Environment:\n" +
        "  ATLAS_API_URL        API server URL (default: http://localhost:3001)\n" +
        "  ATLAS_API_KEY        API key for authentication\n\n" +
        "Examples:\n" +
        '  atlas query "top 5 customers by revenue"\n' +
        '  atlas query "active alerts" --json\n' +
        '  atlas query "count of users" --csv\n' +
        '  atlas query "alerts" --connection cybersec',
    );
    process.exit(1);
  }

  const jsonOutput = args.includes("--json");
  const csvOutput = args.includes("--csv");
  const quietOutput = args.includes("--quiet");
  const autoApprove = args.includes("--auto-approve");
  const connectionId = getFlag(args, "--connection");

  if (jsonOutput && csvOutput) {
    console.error("Error: --json and --csv are mutually exclusive.");
    process.exit(1);
  }

  const apiUrl = (
    process.env.ATLAS_API_URL ?? "http://localhost:3001"
  ).replace(/\/$/, "");
  const apiKey = process.env.ATLAS_API_KEY;

  // Build request
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = { question, ...(connectionId && { connectionId }) };

  // Call the API
  if (!jsonOutput && !csvOutput) process.stderr.write("Thinking...\n");

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/v1/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) {
      console.error("Error: Request timed out after 120 seconds.");
      console.error(
        "  The query may be too complex, or the server may be overloaded.",
      );
    } else if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      console.error(
        `Error: Cannot connect to Atlas API at ${apiUrl}`,
      );
      console.error(
        "  Is the server running? Start it with: bun run dev:api",
      );
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
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
      console.error(`Error: Authentication failed -- ${message}`);
      console.error("  Set ATLAS_API_KEY to a valid API key.");
    } else if (res.status === 429) {
      console.error(`Error: Rate limit exceeded -- ${message}`);
    } else if (errorCode === "no_datasource") {
      console.error(`Error: ${message}`);
      console.error(
        "  The API server has no datasource configured. Set ATLAS_DATASOURCE_URL on the server.",
      );
    } else if (errorCode === "configuration_error") {
      console.error(
        `Error: Server configuration problem -- ${message}`,
      );
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }

  let data: QueryAPIResponse;
  try {
    data = (await res.json()) as QueryAPIResponse;
  } catch {
    console.error("Error: Failed to parse API response as JSON.");
    console.error(
      `  The server at ${apiUrl} returned a 200 status but the body was not valid JSON.`,
    );
    process.exit(1);
  }

  // Runtime validation of response shape
  if (!Array.isArray(data.data)) {
    console.error(
      "Error: Unexpected API response -- the server may be running a different version.",
    );
    if (data.answer) console.log(`\n${data.answer}`);
    process.exit(1);
  }
  if (!Array.isArray(data.sql)) data.sql = [];
  if (!data.usage || typeof data.usage.totalTokens !== "number") {
    data.usage = { totalTokens: 0 };
  }

  // --- JSON output: print raw response and exit ---
  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // --- CSV output: headers + rows, no narrative ---
  if (csvOutput) {
    for (const dataset of data.data) {
      console.log(dataset.columns.map(quoteCsvField).join(","));
      for (const row of dataset.rows) {
        const cells = dataset.columns.map((col) =>
          quoteCsvField(formatCsvValue(row[col])),
        );
        console.log(cells.join(","));
      }
    }
    return;
  }

  // --- Table output (default) ---

  // Narrative answer
  if (!quietOutput && data.answer) {
    console.log(`\n${data.answer}\n`);
  }

  // Data tables
  for (const dataset of data.data) {
    if (dataset.columns.length > 0 && dataset.rows.length > 0) {
      console.log(renderTable(dataset.columns, dataset.rows));
      console.log();
    }
  }

  // Footer: SQL + stats
  if (!quietOutput) {
    if (data.sql.length > 0) {
      console.log(pc.dim(`SQL: ${data.sql[data.sql.length - 1]}`));
    }
    const tokens =
      typeof data.usage?.totalTokens === "number"
        ? data.usage.totalTokens.toLocaleString()
        : "n/a";
    console.log(
      pc.dim(`Steps: ${data.steps ?? "?"} | Tokens: ${tokens}`),
    );
  }

  // --- Handle pending actions ---
  if (data.pendingActions?.length) {
    console.log();
    console.log(
      pc.yellow(
        `${data.pendingActions.length} action(s) require approval:`,
      ),
    );

    if (autoApprove) {
      // Auto-approve all pending actions
      for (const action of data.pendingActions) {
        process.stderr.write(
          `  Approving: ${action.summary}... `,
        );
        const result = await handleActionApproval(
          action.approveUrl,
          apiKey,
        );
        if (result.ok) {
          console.error(
            pc.green(`${result.status ?? "approved"}`),
          );
        } else {
          console.error(pc.red(`failed: ${result.error}`));
        }
      }
    } else if (process.stdout.isTTY) {
      // Interactive TTY mode -- prompt per action
      for (const action of data.pendingActions) {
        console.log(
          `\n  ${pc.bold(action.type)}: ${action.summary}`,
        );
        if (action.target)
          console.log(`  Target: ${action.target}`);

        const choice = await p.select({
          message: "What would you like to do?",
          options: [
            { value: "approve", label: "Approve" },
            { value: "deny", label: "Deny" },
            { value: "skip", label: "Skip (decide later)" },
          ],
        });

        if (p.isCancel(choice) || choice === "skip") {
          console.log(pc.dim(`  Skipped. Approve/deny later:`));
          console.log(
            pc.dim(
              `    Approve: curl -X POST ${action.approveUrl}`,
            ),
          );
          console.log(
            pc.dim(
              `    Deny:    curl -X POST ${action.denyUrl}`,
            ),
          );
          continue;
        }

        const url =
          choice === "approve"
            ? action.approveUrl
            : action.denyUrl;
        const result = await handleActionApproval(url, apiKey);
        if (result.ok) {
          console.log(
            pc.green(
              `  Action ${result.status ?? choice}d.`,
            ),
          );
        } else {
          console.log(pc.red(`  Failed: ${result.error}`));
        }
      }
    } else {
      // Non-TTY, no --auto-approve -- print URLs and exit
      for (const action of data.pendingActions) {
        console.log(`\n  ${action.type}: ${action.summary}`);
        console.log(`    Approve: ${action.approveUrl}`);
        console.log(`    Deny:    ${action.denyUrl}`);
      }
    }
  }
}
