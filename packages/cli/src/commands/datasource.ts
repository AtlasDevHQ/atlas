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
import { readApiKeyFlag, resolveCredential } from "../lib/credential";
import { readSession, type StoredSession } from "../lib/credentials";
import { createProgressTracker } from "../progress";
import {
  DatasourceCliError,
  archiveDatasource,
  createDatasource,
  deleteDatasource,
  getDatasource,
  listDatasources,
  profileDatasource,
  restoreDatasource,
  testDatasource,
  type CreateDatasourceMetadata,
  type DatasourceClientOptions,
  type ProfileResult,
} from "../lib/datasource-client";
import {
  captureDatasourceSecret,
  DATASOURCE_SECRET_ENV,
  type DeferredSecret,
  type SecretCaptureDeps,
} from "../lib/datasource-secret";

const USAGE = `Manage the datasources of your logged-in workspace.

Usage: atlas datasource <command> [id] [options]

Commands:
  list                List the workspace's datasources
  get <id>            Show one datasource's detail
  test <id>           Health-check a datasource connection
  create <id>         Provision a new datasource (secret captured on stdin)
  profile <id>        Profile a datasource & generate its semantic layer (drafts)
  archive <id>        Archive a datasource (reversible via restore)
  restore <id>        Restore an archived datasource
  delete <id>         Delete a datasource (soft — recoverable via restore)

Options:
  --json              Machine-readable JSON output
  --api-key <key>     Use a workspace API key instead of your \`atlas login\` session
                      (unattended CI). Overrides ATLAS_API_KEY.
  --description <s>   (create) Human-readable description
  --schema <s>        (create) Schema to scope to (e.g. a Postgres schema)
  --group <id>        (create) Attach to an existing environment/group
  --new-group <name>  (create) Create a new inline environment/group

Secret capture (create): the connection URL embeds the credential, so it is
NEVER passed as a flag. It is read from the ${DATASOURCE_SECRET_ENV} env var
(headless agents) or prompted on stdin (interactive). CI with no terminal and
no env var defers datasource creation to the dashboard or MCP.

Every datasource command requires the workspace admin role (admin/owner); a
non-admin member is denied with an actionable message.
\`profile\` is long-running: it streams per-table progress and is cancellable
(Ctrl-C). Generated entities land as DRAFTS — publish them from the admin console.

Authentication: \`atlas login\` for interactive use (ambient session reuse — no
key needed), OR a workspace API key via --api-key / ATLAS_API_KEY for unattended
CI. Set ATLAS_API_URL to target a non-local API.`;

/** The id-taking lifecycle subcommands (everything except `list` and `create`). */
const ID_SUBCOMMANDS = ["get", "test", "profile", "archive", "restore", "delete"] as const;
type IdSubcommand = (typeof ID_SUBCOMMANDS)[number];

/** Every datasource subcommand. `create` takes an id positional plus option flags. */
const DATASOURCE_SUBCOMMANDS = ["list", "create", ...ID_SUBCOMMANDS] as const;
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
  /**
   * A workspace-scoped API key for unattended CI (#4046), resolved from the
   * `--api-key` flag or the `ATLAS_API_KEY` env var. When present it takes
   * precedence over the stored session — CI never goes through `atlas login`.
   */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Secret-capture probes + prompt for `create` (injected so tests exercise the
   * env/stdin/defer branches without a real TTY). Defaults to the live
   * `process`/`@clack` wiring in `handleDatasource` when omitted.
   */
  readonly secretCapture?: SecretCaptureDeps;
}

/**
 * First non-flag argument after the subcommand (the datasource id), if any.
 * Skips the value consumed by `--api-key <key>` (the one value-taking flag the
 * id-subcommands accept) so the key is never mistaken for the id.
 */
function positionalId(args: string[]): string | undefined {
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--api-key") {
      i++; // skip the key value
      continue;
    }
    if (a.startsWith("--")) continue;
    return a;
  }
  return undefined;
}

/** The `create` flags that consume the following argument as their value. */
const CREATE_VALUE_FLAGS = ["--description", "--schema", "--group", "--new-group"] as const;

/**
 * Extract the datasource id positional from a `create` invocation, skipping any
 * value consumed by a `--flag value` option so a flag's value (e.g. the
 * description) is never mistaken for the id. `--flag=value` forms consume no
 * following token, so only the space-separated form needs the skip. Boolean
 * flags like `--json` consume nothing. Returns undefined when no id is present.
 */
function createPositionalId(args: string[]): string | undefined {
  // `--api-key <key>` is a global credential flag (not create metadata), but it
  // still consumes its following token — include it so the key isn't read as id.
  const valueFlags = new Set<string>([...CREATE_VALUE_FLAGS, "--api-key"]);
  // Skip args[0] ("datasource") and args[1] ("create").
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.has(a)) {
      i++; // skip the value token this flag consumes
      continue;
    }
    if (a.startsWith("--")) continue; // boolean flag or `--flag=value`
    return a;
  }
  return undefined;
}

/**
 * Read the value of a `--flag <value>` option from argv (supports both
 * `--flag value` and `--flag=value`). Returns undefined when the flag is absent.
 * Secrets are NEVER read this way — only non-sensitive create metadata.
 */
function flagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const next = args[i + 1];
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }
    if (a.startsWith(prefix)) {
      return a.slice(prefix.length);
    }
  }
  return undefined;
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

/** Print the generated-layer summary for a completed profile. */
function renderProfileResult(io: DatasourceIO, result: ProfileResult): void {
  const status = result.persisted ? result.persistedStatus ?? "draft" : "in-memory";
  io.out(
    `Profiled "${result.id}": generated ${result.entitiesGenerated} entities` +
      ` and ${result.metricsGenerated} metrics as ${status}.`,
  );
  if (result.persisted) {
    io.out("  Generated entities are saved as drafts — publish them from the admin console to make");
    io.out("  them queryable from the published /chat surface (they are queryable now in developer mode).");
  }
  if (result.incomplete) {
    const failed = result.incompleteTables ?? [];
    io.out(
      `  Warning: the profile is incomplete — ${result.profilingErrors} table${
        result.profilingErrors === 1 ? "" : "s"
      } failed introspection and ${failed.length === 1 ? "is" : "are"} absent: ${failed.join(", ")}`,
    );
  }
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

  // A workspace API key (#4046, unattended CI) takes precedence over a stored
  // login; the flag (either `--api-key key` or `--api-key=key`) wins over the env
  // var (deps.apiKey). Keys are workspace-pinned, so no rebind is needed.
  const apiKey = readApiKeyFlag(args) ?? deps.apiKey;
  const credential = resolveCredential(apiKey, deps.session);
  if (!credential) {
    io.err("Not logged in. Run `atlas login` first, or set ATLAS_API_KEY for unattended use.");
    return 1;
  }

  const opts: DatasourceClientOptions = {
    baseUrl: deps.baseUrl,
    credential,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const json = args.includes("--json");

  // `create` takes an id positional plus option flags, and captures the secret
  // URL on stdin / from an env var (ADR-0025 §4) — handled before the generic
  // id-subcommand path so its distinct argument shape and secret capture apply.
  if (subcommand === "create") {
    return runCreate(args, opts, json, deps, io);
  }

  // Lifecycle subcommands other than `list` require a datasource id.
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
    // An api-key path has no local session, so the bound workspace id isn't
    // known client-side — the server resolves it from the key. Fall back to
    // null (the empty-state line and JSON envelope both tolerate it).
    const workspaceId = deps.session?.workspaceId ?? null;
    if (json) {
      io.out(JSON.stringify({ workspaceId, datasources }, null, 2));
    } else {
      renderList(io, workspaceId, datasources);
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
      case "profile": {
        // Long-running + streamed. Drive the shared progress tracker (spinner in
        // a TTY, plain stderr lines otherwise) from the server's NDJSON events,
        // and wire SIGINT to an AbortController so Ctrl-C cancels the profile
        // cleanly rather than leaving a dangling request. In --json mode we skip
        // the live progress and just emit the terminal result object.
        const tracker = json ? undefined : createProgressTracker();
        const controller = new AbortController();
        const onSigint = () => controller.abort();
        process.once("SIGINT", onSigint);
        try {
          const result = await profileDatasource(opts, {
            id,
            signal: controller.signal,
            ...(tracker
              ? {
                  reporter: {
                    onStart: (total) => tracker.onStart(total),
                    onTable: (e) =>
                      e.status === "error"
                        ? tracker.onTableError(e.name, e.error ?? "profiling error", e.index, e.total)
                        : tracker.onTableDone(e.name, e.index, e.total),
                  },
                }
              : {}),
          });
          if (tracker) tracker.onComplete(result.entitiesGenerated, result.elapsedMs);
          if (json) {
            io.out(JSON.stringify(result, null, 2));
          } else {
            renderProfileResult(io, result);
          }
          return 0;
        } catch (err) {
          // Tear the spinner down before the error surfaces, so a cancelled
          // (Ctrl-C) or failed profile doesn't leave it spinning. The error
          // itself is rendered by the outer handler (handleError → io.err).
          if (tracker) {
            const reason =
              err instanceof DatasourceCliError && err.kind === "network"
                ? "Profiling cancelled."
                : "Profiling failed.";
            tracker.onAbort(reason);
          }
          throw err;
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
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

/**
 * Actionable message for each reason the secret capture deferred (no secret
 * obtained). Typed against `DeferredSecret["reason"]` (the SSOT in the secret
 * module) with a `never` exhaustiveness backstop, so adding a new defer reason
 * fails to compile here until its message is added.
 */
function deferredMessage(reason: DeferredSecret["reason"]): string {
  switch (reason) {
    case "no_tty_no_env":
      return (
        `No interactive terminal and ${DATASOURCE_SECRET_ENV} is not set, so the connection ` +
        `URL can't be captured safely. For a headless agent, export the URL as ` +
        `${DATASOURCE_SECRET_ENV} for this one command. CI without a terminal should provision ` +
        `the datasource via the dashboard or the Atlas MCP and reference it instead.`
      );
    case "empty_env":
      return `${DATASOURCE_SECRET_ENV} is set but empty. Set it to the full connection URL, or unset it to be prompted on stdin.`;
    case "empty_stdin":
      return "No connection URL was entered. Re-run and paste the full URL at the prompt.";
    case "cancelled":
      return "Cancelled — no datasource was created.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * `atlas datasource create <id> [options]` — provision a datasource (#4051).
 *
 * The id positional + option flags carry only NON-secret metadata; the
 * connection URL (the secret) is captured separately on stdin or from the
 * env var and handed to the client as a distinct argument so it can never be
 * logged alongside the metadata or leak through argv.
 */
async function runCreate(
  args: string[],
  opts: DatasourceClientOptions,
  json: boolean,
  deps: DatasourceRunDeps,
  io: DatasourceIO,
): Promise<number> {
  const id = createPositionalId(args);
  if (!id) {
    io.err("Usage: atlas datasource create <id> [--description <s>] [--schema <s>] [--group <id> | --new-group <name>]");
    return 1;
  }

  const description = flagValue(args, "--description");
  const schema = flagValue(args, "--schema");
  const connectionGroupId = flagValue(args, "--group");
  const newGroupName = flagValue(args, "--new-group");

  // Mutual exclusivity mirrors the server's 400; catching it client-side gives a
  // crisper message and saves a round trip (the server still enforces it).
  if (connectionGroupId !== undefined && newGroupName !== undefined) {
    io.err("Pass either --group (attach existing) or --new-group (create inline), not both.");
    return 1;
  }

  if (!deps.secretCapture) {
    // Defensive: the shell (`handleDatasource`) always injects this. A missing
    // capture dep is a programming error, surfaced rather than silently skipped.
    io.err("Internal error: secret capture is not configured.");
    return 1;
  }

  const captured = await captureDatasourceSecret(deps.secretCapture);
  if (captured.kind === "deferred") {
    io.err(deferredMessage(captured.reason));
    // A user-driven cancel is a clean no-op (exit 0); every other defer reason is
    // a failure to provision (exit 1) so scripts can branch on it.
    return captured.reason === "cancelled" ? 0 : 1;
  }

  const metadata: CreateDatasourceMetadata = {
    id,
    ...(description !== undefined ? { description } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(connectionGroupId !== undefined ? { connectionGroupId } : {}),
    ...(newGroupName !== undefined ? { newGroupName } : {}),
  };

  try {
    const result = await createDatasource(opts, metadata, captured.url);
    if (json) {
      io.out(JSON.stringify(result, null, 2));
    } else {
      const dbType = typeof result.dbType === "string" ? result.dbType : "";
      const maskedUrl = typeof result.maskedUrl === "string" ? result.maskedUrl : "";
      io.out(`Created datasource "${id}"${dbType ? ` (${dbType})` : ""} from ${captured.source}.`);
      if (maskedUrl.length > 0) io.out(`  URL: ${maskedUrl}`);
      io.out(`  It landed as a draft — publish it in the Atlas console (or it stays dev-only).`);
      io.out(`  Health-check it with: atlas datasource test ${id}`);
    }
    return 0;
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

/**
 * Build the live secret-capture wiring: env var, the real TTY probe, and a
 * masked `@clack` prompt. Imported lazily so the common (non-`create`) commands
 * don't pull the prompt library, and so tests inject their own deps instead.
 */
function liveSecretCapture(): SecretCaptureDeps {
  return {
    envValue: process.env[DATASOURCE_SECRET_ENV],
    isTTY: Boolean(process.stdin.isTTY),
    promptSecret: async () => {
      const p = await import("@clack/prompts");
      const value = await p.password({
        message: "Connection URL (input hidden; not stored in shell history)",
      });
      // `p.isCancel` flags Ctrl-C / Esc — map it to the module's null cancel
      // sentinel so the secret module stays prompt-library-agnostic.
      return p.isCancel(value) ? null : value;
    },
  };
}

/** Thin shell main() invokes: resolve the credential + base URL, then dispatch. */
export async function handleDatasource(args: string[]): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  // ATLAS_API_KEY (#4046) is the unattended-CI credential — it is NOT persisted
  // to ~/.atlas/credentials (a CI secret managed by the CI system, not an
  // interactive login). `--api-key` (parsed in runDatasource) overrides it.
  const apiKey = process.env.ATLAS_API_KEY?.trim() || undefined;
  const code = await runDatasource(args, {
    baseUrl,
    session,
    ...(apiKey ? { apiKey } : {}),
    secretCapture: liveSecretCapture(),
  });
  if (code !== 0) process.exit(code);
}
