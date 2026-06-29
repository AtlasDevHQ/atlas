/**
 * `atlas explore` (#4049 / ADR-0025 missing endpoint #3).
 *
 * The workspace CLI surface for read-only semantic-layer exploration — a thin
 * HTTP client over `POST /api/v1/explore`, authorized entirely by the `atlas
 * login` workspace credential. Runs a single read-only bash command
 * (ls/cat/grep/find/…) against ONLY the bound workspace's semantic layer; the
 * server sandboxes execution with read-only, path-traversal-protected access
 * scoped to `semantic/`, so writes, shell escapes, and traversal are rejected
 * server-side (the CLI does no command validation of its own).
 *
 * The dispatch + rendering live in the testable `runExplore` core (deps are
 * injected: the session, the API base URL, and `fetch`), so request shaping,
 * output, and the HTTP-status → message mapping are unit-tested without a live
 * server or `process.exit`. `handleExplore` is the thin shell main() calls.
 */

import { resolveApiBaseUrl } from "../lib/api-base";
import { credentialHeaders, resolveCredential } from "../lib/credential";
import { readSession, type StoredSession } from "../lib/credentials";
import { asRecord, serverMessage } from "../lib/http";

const USAGE = `Run a read-only command against your logged-in workspace's semantic layer.

Usage: atlas explore <command...> [--api-key <key>] [--json]

Examples:
  atlas explore ls
  atlas explore "cat catalog.yml"
  atlas explore grep -r revenue entities/
  atlas explore "find . -name '*.yml'" --json

Options:
  --api-key <key>     Use a workspace API key instead of your \`atlas login\` session
                      (unattended CI). Overrides ATLAS_API_KEY.
  --json              Machine-readable JSON output ({ "output": "..." })

Only read-only commands run (ls/cat/grep/find/head/tail/wc/awk/sed/pipes). The
server sandboxes execution scoped to the semantic layer — writes, shell escapes,
and path traversal are rejected.

Authentication: \`atlas login\` for interactive use (ambient session reuse — no
key needed), OR a workspace API key via --api-key / ATLAS_API_KEY for unattended
CI. Set ATLAS_API_URL to target a non-local API.`;

/** stdout/stderr sink — injected so tests can capture output. */
export interface ExploreIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIO: ExploreIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Everything `runExplore` needs, injected so it stays server-free in tests. */
export interface ExploreRunDeps {
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

/** Response shape from `POST /api/v1/explore`. */
interface ExploreResponse {
  output?: string;
}

/** CLI-owned flags stripped from the argv before the rest becomes the command. */
const CLI_FLAGS = new Set(["--json", "--help", "-h"]);
const API_KEY_FLAG = "--api-key";

/**
 * Split the argv into the explore command string and the optional `--api-key`
 * value. The command is every token after the literal EXCEPT this CLI's own
 * flags (`--json`/`--help`/`-h`) and the credential flag (`--api-key <key>` or
 * `--api-key=<key>`) — so neither the key nor the flag itself leaks into the
 * command the server runs, while a command's own `--`-style argument (e.g.
 * `grep --include='*.yml'`) is preserved.
 */
function parseExploreArgs(args: string[]): { command: string; apiKey?: string } {
  const tokens = args.slice(1);
  const positional: string[] = [];
  let apiKey: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === API_KEY_FLAG) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        apiKey = next;
        i++; // consume the value token
      }
      continue;
    }
    if (a.startsWith(`${API_KEY_FLAG}=`)) {
      apiKey = a.slice(API_KEY_FLAG.length + 1);
      continue;
    }
    if (CLI_FLAGS.has(a)) continue;
    positional.push(a);
  }
  return { command: positional.join(" ").trim(), ...(apiKey ? { apiKey } : {}) };
}

/**
 * Run the explore command. Returns an exit code (0 success, 1 failure) without
 * calling `process.exit`, so tests can assert on it directly.
 *
 * `args` is the full argv slice (args[0] === "explore"). The command is every
 * token after the literal EXCEPT this CLI's own flags (`--json`/`--help`/`-h`),
 * joined with spaces — so both `atlas explore ls entities/` and
 * `atlas explore "cat catalog.yml"` work, and a command that legitimately needs
 * a `--`-style argument (e.g. `grep --include='*.yml' -r foo .`) keeps it
 * rather than having it silently dropped.
 */
export async function runExplore(
  args: string[],
  deps: ExploreRunDeps,
  io: ExploreIO = defaultIO,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }

  const json = args.includes("--json");
  const { command, apiKey: argApiKey } = parseExploreArgs(args);

  if (!command) {
    io.out(USAGE);
    return 1;
  }

  // A workspace API key (#4046, unattended CI) takes precedence over a stored
  // login; the flag wins over the env var (deps.apiKey). Keys are
  // workspace-pinned, so no rebind is needed.
  const apiKey = argApiKey ?? deps.apiKey;
  const credential = resolveCredential(apiKey, deps.session);
  if (!credential) {
    io.err("Not logged in. Run `atlas login` first, or set ATLAS_API_KEY for unattended use.");
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${deps.baseUrl}/api/v1/explore`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...credentialHeaders(credential),
      },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    io.err(
      `Failed to reach the Atlas API at ${deps.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (res.status === 401) {
    io.err("Your session is no longer valid. Run `atlas login` again.");
    return 1;
  }
  if (!res.ok) {
    // The server returns 200 even for non-zero-exit commands (a `grep` no-match),
    // so a non-ok status here is a genuine request failure. Surface the server's
    // actionable message + requestId (Atlas error envelopes carry one) via the
    // shared `serverMessage`, parity with `atlas sql`/`metric`/`datasource`.
    // Explore is `standardAuth` with NO role gate — its only 403 is
    // `ip_not_allowed`, whose server message already names the cause, so there is
    // no role-specific copy to hardcode (the prior branch did, incorrectly).
    // intentionally ignored: a non-JSON error body's `res.json()` rejects → the
    // `.catch(() => null)` yields null → `asRecord(null)` returns {} → serverMessage
    // degrades to its `HTTP <status>` fallback rather than crashing.
    const body = asRecord(await res.json().catch(() => null));
    io.err(serverMessage(body, res.status));
    return 1;
  }

  // intentionally ignored: a non-JSON / empty 2xx body degrades to "(no output)"
  // rather than crashing — res.ok was already checked above.
  const body = (await res.json().catch(() => null)) as ExploreResponse | null;
  const output = body?.output ?? "";

  if (json) {
    io.out(JSON.stringify({ output }, null, 2));
    return 0;
  }

  io.out(output.length > 0 ? output : "(no output)");
  return 0;
}

/** Thin shell main() invokes: resolve the credential + base URL, then dispatch. */
export async function handleExplore(args: string[]): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  // ATLAS_API_KEY (#4046) is the unattended-CI credential — it is NOT persisted
  // to ~/.atlas/credentials (a CI secret managed by the CI system, not an
  // interactive login). `--api-key` (parsed in runExplore) overrides it.
  const apiKey = process.env.ATLAS_API_KEY?.trim() || undefined;
  const code = await runExplore(args, { baseUrl, session, ...(apiKey ? { apiKey } : {}) });
  if (code !== 0) process.exit(code);
}
