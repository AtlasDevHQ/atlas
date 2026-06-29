/**
 * `atlas datasource create` secret capture (#4051 / ADR-0025 sub-decision 4).
 *
 * A datasource's connection URL embeds its credentials (the password), so it is
 * the secret. The CLI has no LLM context to protect (the MCP's concern), but it
 * DOES have `argv`, shell history, and process logs to keep the secret OUT of.
 * So the connection URL is NEVER accepted as a flag. It is captured by exactly
 * one of two paths, in priority order:
 *
 *   1. `env` — the headless-agent path. When the secret env var is set, its
 *      value is read at the moment of the request. An agent with no TTY exports
 *      the var for one invocation; it never lands in argv.
 *   2. `stdin` — the human path. With an interactive terminal, prompt for the
 *      URL with a masked input (like `git`/`psql` passphrase prompts). The
 *      keystrokes never echo and never enter shell history.
 *
 * When NEITHER path is available — no env var AND no TTY (a CI runner) — capture
 * fails closed with `kind: "deferred"`: per ADR-0025 §4, CI/automation without an
 * interactive terminal defers datasource creation to the dashboard or MCP and
 * uses pre-provisioned datasources. We never silently read from argv as a
 * fallback; that is precisely the leak this guards against.
 *
 * The masked prompt and TTY/env probes are injected (`SecretCaptureDeps`) so the
 * resolution logic is unit-testable without a real terminal or mutating
 * `process.env`.
 */

/** The env var an agent exports to supply the connection URL headlessly. */
export const DATASOURCE_SECRET_ENV = "ATLAS_DATASOURCE_SECRET";

/** Where a captured secret came from — surfaced so the command can note the path taken. */
export type SecretSource = "env" | "stdin";

/** A successful capture: the secret URL plus which path produced it. */
export interface CapturedSecret {
  readonly kind: "captured";
  readonly url: string;
  readonly source: SecretSource;
}

/**
 * Capture could not proceed because there is no interactive terminal and no env
 * var — the CI-defers-to-dashboard/MCP case. Carries a `reason` enum so the
 * caller renders the right actionable message.
 */
export interface DeferredSecret {
  readonly kind: "deferred";
  /**
   * - `no_tty_no_env` — no TTY and the env var is unset (the ADR-0025 §4 CI case).
   * - `empty_env` — the env var is set but blank; treated as a misconfiguration,
   *   not a silent fall-through to a prompt, so a CI typo fails loud.
   * - `empty_stdin` — the interactive prompt returned an empty value.
   * - `cancelled` — the user aborted the prompt (Ctrl-C / Esc).
   */
  readonly reason: "no_tty_no_env" | "empty_env" | "empty_stdin" | "cancelled";
}

export type SecretCaptureResult = CapturedSecret | DeferredSecret;

/** Injected probes + prompt so capture is testable without a real TTY or env mutation. */
export interface SecretCaptureDeps {
  /** The secret env var's value, or undefined when unset. */
  readonly envValue: string | undefined;
  /** Whether stdin is an interactive terminal. */
  readonly isTTY: boolean;
  /**
   * Masked interactive prompt. Resolves to the entered string, or a cancel
   * sentinel the dep maps to `null` (so this module never imports the prompt
   * library directly and stays trivially unit-testable).
   */
  readonly promptSecret: () => Promise<string | null>;
}

/**
 * Resolve the datasource connection URL (the secret) without ever touching
 * argv. Env var wins over the interactive prompt; absent both, defers.
 */
export async function captureDatasourceSecret(
  deps: SecretCaptureDeps,
): Promise<SecretCaptureResult> {
  // 1. Headless path: an explicitly-set env var is the agent's request-time
  //    credential. A set-but-blank var is a misconfiguration we surface rather
  //    than papering over with a prompt that may not even be reachable.
  if (deps.envValue !== undefined) {
    const trimmed = deps.envValue.trim();
    if (trimmed.length === 0) {
      return { kind: "deferred", reason: "empty_env" };
    }
    return { kind: "captured", url: trimmed, source: "env" };
  }

  // 2. No env var: only an interactive terminal can supply the secret safely.
  //    A non-TTY here is the CI case → defer to the dashboard/MCP.
  if (!deps.isTTY) {
    return { kind: "deferred", reason: "no_tty_no_env" };
  }

  const entered = await deps.promptSecret();
  if (entered === null) {
    return { kind: "deferred", reason: "cancelled" };
  }
  const trimmed = entered.trim();
  if (trimmed.length === 0) {
    return { kind: "deferred", reason: "empty_stdin" };
  }
  return { kind: "captured", url: trimmed, source: "stdin" };
}
