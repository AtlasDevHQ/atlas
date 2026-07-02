/**
 * The command shell shared by the REST-backed workspace subcommands
 * (`sql`/`metric`/`query`/`explore`/`datasource`) — #4196, finishing the
 * explicitly-partial #4112/#4113 extraction.
 *
 * Every one of those `handleX` shells did the SAME five things: resolve the API
 * base URL, read the stored session for it, pick up the unattended-CI
 * `ATLAS_API_KEY` env var (trimmed, never persisted), dispatch the testable
 * `runXCommand` core with those injected as deps, then `process.exit(code)` on a
 * non-zero exit. That boilerplate lived verbatim in five files; it lives here
 * once. Each command now supplies ONLY its arg-parse + render core.
 *
 * The `CliIO` sink and the `WorkspaceCommandDeps` shape were likewise duplicated
 * per command; they are defined here as the shared vocabulary the cores type
 * against (each command re-exports them under its historical local name so its
 * tests' imports stay stable).
 *
 * This module owns the ONLY `process.exit` in the workspace-command path — the
 * cores return an exit code and never exit, so they stay unit-testable without a
 * live server or a real process.
 */

import { resolveApiBaseUrl } from "./api-base";
import { readSession, type StoredSession } from "./credentials";

/**
 * The stdout/stderr sink injected into every command core so tests can capture
 * output instead of writing to the real console. `defaultCliIO` is the live
 * wiring used when a command runs for real.
 */
export interface CliIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The live console sink — the default when a command isn't under test. */
export const defaultCliIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * Everything a REST-backed workspace command core needs, injected so it stays
 * server-free in tests: the resolved API base URL, the stored session (or null),
 * the optional unattended-CI API key, and an injectable `fetch`. Commands that
 * need extra wiring (e.g. `datasource`'s secret capture) extend this shape.
 */
export interface WorkspaceCommandDeps {
  /** Normalized Atlas API base URL (no trailing slash). */
  readonly baseUrl: string;
  /** The `atlas login` session bound to `baseUrl`, or null when not logged in. */
  readonly session: StoredSession | null;
  /**
   * A workspace-scoped API key for unattended CI (#4046), from the `--api-key`
   * flag or `ATLAS_API_KEY`. When present it takes precedence over the stored
   * session — CI never goes through `atlas login`.
   */
  readonly apiKey?: string;
  /** Injectable `fetch` for tests; defaults to the global when omitted. */
  readonly fetchImpl?: typeof fetch;
}

/** A testable command core: parse argv + render, returning an exit code (never exits). */
export type WorkspaceCommandRun = (
  args: string[],
  deps: WorkspaceCommandDeps,
) => Promise<number>;

/**
 * The shell `handleX` invokes: resolve the base URL + session + `ATLAS_API_KEY`,
 * dispatch `run` with those as deps, then `process.exit(code)` on a non-zero
 * exit (a zero exit returns normally so the process ends naturally). This is the
 * single place credential inputs are gathered and the exit code is applied — the
 * cores are pure and return their code.
 */
export async function runWorkspaceCommand(
  args: string[],
  run: WorkspaceCommandRun,
): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const session = readSession(baseUrl);
  // ATLAS_API_KEY (#4046) is the unattended-CI credential — it is NOT persisted
  // to ~/.atlas/credentials (a CI secret managed by the CI system, not an
  // interactive login). The `--api-key` flag (parsed in each core) overrides it.
  const apiKey = process.env.ATLAS_API_KEY?.trim() || undefined;
  const code = await run(args, { baseUrl, session, ...(apiKey ? { apiKey } : {}) });
  if (code !== 0) process.exit(code);
}
