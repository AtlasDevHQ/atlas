/**
 * `atlas datasource list|get|test|archive|restore|delete` (#4044 / ADR-0025 sub-decision 3).
 *
 * The workspace CLI surface for datasource lifecycle — a thin HTTP client over
 * the EXISTING admin-connection REST routes (`datasource-client.ts`), authorized
 * entirely by the `atlas login` workspace credential. Each subcommand maps to one
 * route; there is no duplicated business logic. Operations act on ONLY the bound
 * workspace's datasources (the bearer resolves live to `{ orgId, role }`).
 * EVERY command requires the workspace admin role — the admin-connection routes
 * are admin-gated end to end (matching the MCP parity reference, where datasource
 * metadata is itself an admin surface). A non-admin member is denied (with the
 * mutating ops being the most consequential) and gets an actionable message.
 *
 * Parity reference: `packages/mcp/src/datasource-tools.ts` for list/get/test/
 * archive. `restore` and `delete` intentionally DIVERGE from the MCP tools
 * because each maps to a different REST route: this CLI's `restore` republishes
 * (the `restore-connection` route → `status='published'`) whereas the MCP revives
 * to a draft, and this CLI's `delete` is a soft, restorable archive (the
 * `DELETE` route → `uninstallDatasource` without `hard`) whereas the MCP
 * `delete_datasource` is an irreversible hard delete.
 *
 * The dispatch + rendering live in the testable `runDatasource` core (deps are
 * injected: the session, the API base URL, and `fetch`), so route mapping,
 * output, and the typed-error → message mapping are unit-tested without a live
 * server or `process.exit`. `handleDatasource` is the thin shell main() calls.
 */

import { renderTable } from "../../lib/output";
import { resolveApiBaseUrl } from "../lib/api-base";
import { readSession, type StoredSession } from "../lib/credentials";
import {
  DatasourceCliError,
  archiveDatasource,
  deleteDatasource,
  getDatasource,
  listDatasources,
  restoreDatasource,
  testDatasource,
  type DatasourceClientOptions,
} from "../lib/datasource-client";

const USAGE = `Manage the datasources of your logged-in workspace.

Usage: atlas datasource <command> [id] [--json]

Commands:
  list                List the workspace's datasources
  get <id>            Show one datasource's detail
  test <id>           Health-check a datasource connection
  archive <id>        Archive a datasource (reversible via restore)
  restore <id>        Restore an archived datasource
  delete <id>         Delete a datasource (soft — recoverable via restore)

Options:
  --json              Machine-readable JSON output

Every datasource command requires the workspace admin role (admin/owner); a
non-admin member is denied with an actionable message.
Requires \`atlas login\` first. Set ATLAS_API_URL to target a non-local API.`;

/** The id-taking subcommands (everything except `list`). */
const ID_SUBCOMMANDS = ["get", "test", "archive", "restore", "delete"] as const;
type IdSubcommand = (typeof ID_SUBCOMMANDS)[number];

/** Every datasource subcommand. */
const DATASOURCE_SUBCOMMANDS = ["list", ...ID_SUBCOMMANDS] as const;
type DatasourceSubcommand = (typeof DATASOURCE_SUBCOMMANDS)[number];

function isDatasourceSubcommand(value: string): value is DatasourceSubcommand {
  return (DATASOURCE_SUBCOMMANDS as readonly string[]).includes(value);
}

/** stdout/stderr sink — injected so tests can capture output. */
export interface DatasourceIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIO: DatasourceIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Everything `runDatasource` needs, injected so it stays server-free in tests. */
export interface DatasourceRunDeps {
  readonly baseUrl: string;
  readonly session: StoredSession | null;
  readonly fetchImpl?: typeof fetch;
}

/** First non-flag argument after the subcommand (the datasource id), if any. */
function positionalId(args: string[]): string | undefined {
  return args.slice(2).find((a) => !a.startsWith("--"));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Pretty-print a datasource list as a table; falls back to an empty-state line. */
function renderList(io: DatasourceIO, workspaceId: string | null, datasources: unknown[]): void {
  if (datasources.length === 0) {
    io.out(
      workspaceId
        ? `Workspace ${workspaceId} has no datasources.`
        : "No datasources configured for this workspace.",
    );
    return;
  }
  const rows = datasources.map((d) => {
    const r = asRecord(d);
    const health = asRecord(r.health);
    return {
      id: typeof r.id === "string" ? r.id : "",
      type: typeof r.dbType === "string" ? r.dbType : "",
      status: typeof r.status === "string" ? r.status : "",
      group: typeof r.groupId === "string" ? r.groupId : "-",
      health: typeof health.status === "string" ? health.status : "-",
    };
  });
  io.out(renderTable(["id", "type", "status", "group", "health"], rows));
}

/** Print the readable subset of a datasource detail record. */
function renderDetail(io: DatasourceIO, id: string, detail: Record<string, unknown>): void {
  io.out(`Datasource: ${id}`);
  const fields: Array<[string, string]> = [
    ["Type", "dbType"],
    ["Status", "status"],
    ["Schema", "schema"],
    ["Group", "groupId"],
    ["URL", "maskedUrl"],
    ["Description", "description"],
  ];
  for (const [label, key] of fields) {
    const v = detail[key];
    if (typeof v === "string" && v.length > 0) io.out(`  ${label}: ${v}`);
  }
  const health = asRecord(detail.health);
  if (typeof health.status === "string") io.out(`  Health: ${health.status}`);
}

/**
 * Testable core: dispatch one `atlas datasource` invocation. Returns the process
 * exit code (0 success, 1 failure) without calling `process.exit`, so tests can
 * assert on it directly.
 *
 * `args` is the full argv slice (args[0] === "datasource").
 */
export async function runDatasource(
  args: string[],
  deps: DatasourceRunDeps,
  io: DatasourceIO = defaultIO,
): Promise<number> {
  const subcommand = args[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    io.out(USAGE);
    return subcommand ? 0 : 1;
  }

  if (!isDatasourceSubcommand(subcommand)) {
    io.err(`Unknown datasource command: ${subcommand}\n`);
    io.out(USAGE);
    return 1;
  }

  if (!deps.session) {
    io.err("Not logged in. Run `atlas login` first.");
    return 1;
  }

  const opts: DatasourceClientOptions = {
    baseUrl: deps.baseUrl,
    token: deps.session.token,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const json = args.includes("--json");

  // Subcommands other than `list` require a datasource id.
  if (subcommand !== "list") {
    const id = positionalId(args);
    if (!id) {
      io.err(`Usage: atlas datasource ${subcommand} <id>`);
      return 1;
    }
    return runIdSubcommand(subcommand, id, opts, json, io);
  }

  try {
    const datasources = await listDatasources(opts);
    if (json) {
      io.out(JSON.stringify({ workspaceId: deps.session.workspaceId, datasources }, null, 2));
    } else {
      renderList(io, deps.session.workspaceId, datasources);
    }
    return 0;
  } catch (err) {
    return handleError(err, io);
  }
}

/** Run one of the id-taking subcommands (everything except `list`). */
async function runIdSubcommand(
  subcommand: IdSubcommand,
  id: string,
  opts: DatasourceClientOptions,
  json: boolean,
  io: DatasourceIO,
): Promise<number> {
  try {
    switch (subcommand) {
      case "get": {
        const detail = await getDatasource(opts, id);
        if (json) io.out(JSON.stringify(detail, null, 2));
        else renderDetail(io, id, detail);
        return 0;
      }
      case "test": {
        const result = await testDatasource(opts, id);
        const status = typeof result.status === "string" ? result.status : "unknown";
        const healthy = status === "healthy";
        if (json) {
          io.out(JSON.stringify(result, null, 2));
        } else {
          const latency = typeof result.latencyMs === "number" ? ` (${result.latencyMs}ms)` : "";
          io.out(`Datasource "${id}": ${status}${latency}`);
          if (typeof result.message === "string" && result.message.length > 0) {
            io.out(`  ${result.message}`);
          }
        }
        // Non-healthy is a non-zero exit so scripts can branch on it.
        return healthy ? 0 : 1;
      }
      case "archive": {
        const result = await archiveDatasource(opts, id);
        if (json) io.out(JSON.stringify(result, null, 2));
        else io.out(`Archived datasource "${id}". Restore it with: atlas datasource restore ${id}`);
        return 0;
      }
      case "restore": {
        const result = await restoreDatasource(opts, id);
        if (json) io.out(JSON.stringify(result, null, 2));
        else io.out(`Restored datasource "${id}" — it is published and queryable again.`);
        return 0;
      }
      case "delete": {
        const result = await deleteDatasource(opts, id);
        if (json) io.out(JSON.stringify(result, null, 2));
        else io.out(`Deleted datasource "${id}". This is a soft delete — restore it with: atlas datasource restore ${id}`);
        return 0;
      }
      default: {
        // Exhaustiveness: every IdSubcommand is handled above, so this is
        // unreachable. A new id-taking subcommand will fail to compile here
        // until its case is added.
        const _exhaustive: never = subcommand;
        io.err(`Unknown datasource command: ${String(_exhaustive)}`);
        return 1;
      }
    }
  } catch (err) {
    return handleError(err, io);
  }
}

/** Map a typed client error (or anything else) to an error line + exit code. */
function handleError(err: unknown, io: DatasourceIO): number {
  if (err instanceof DatasourceCliError) {
    io.err(err.message);
    return 1;
  }
  // Unexpected — surface it rather than swallowing (no silent failures).
  io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
}

/** Thin shell main() invokes: resolve the credential + base URL, then dispatch. */
export async function handleDatasource(args: string[]): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  const code = await runDatasource(args, { baseUrl, session });
  if (code !== 0) process.exit(code);
}
