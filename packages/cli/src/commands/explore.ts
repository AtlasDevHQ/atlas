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
import { readSession, type StoredSession } from "../lib/credentials";

const USAGE = `Run a read-only command against your logged-in workspace's semantic layer.

Usage: atlas explore <command...> [--json]

Examples:
  atlas explore ls
  atlas explore "cat catalog.yml"
  atlas explore grep -r revenue entities/
  atlas explore "find . -name '*.yml'" --json

Options:
  --json              Machine-readable JSON output ({ "output": "..." })

Only read-only commands run (ls/cat/grep/find/head/tail/wc/awk/sed/pipes). The
server sandboxes execution scoped to the semantic layer — writes, shell escapes,
and path traversal are rejected.
Requires \`atlas login\` first. Set ATLAS_API_URL to target a non-local API.`;

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
  readonly fetchImpl?: typeof fetch;
}

/** Response shape from `POST /api/v1/explore`. */
interface ExploreResponse {
  output?: string;
}

/** CLI-owned flags stripped from the argv before the rest becomes the command. */
const CLI_FLAGS = new Set(["--json", "--help", "-h"]);

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
  const command = args
    .slice(1)
    .filter((a) => !CLI_FLAGS.has(a))
    .join(" ")
    .trim();

  if (!command) {
    io.out(USAGE);
    return 1;
  }

  if (!deps.session) {
    io.err("Not logged in. Run `atlas login` first.");
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${deps.baseUrl}/api/v1/explore`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.session.token}`,
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
  if (res.status === 403) {
    io.err("This workspace is not accessible with your current role.");
    return 1;
  }
  if (!res.ok) {
    // The server returns 200 even for non-zero-exit commands (a `grep`
    // no-match), so a non-ok status here is a genuine request failure.
    let detail = "";
    // intentionally ignored: a non-JSON error body degrades to the status code
    // below rather than crashing.
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    if (body?.message) detail = `: ${body.message}`;
    io.err(`Request failed (HTTP ${res.status})${detail}.`);
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
  const code = await runExplore(args, { baseUrl, session });
  if (code !== 0) process.exit(code);
}
