/**
 * TwentyCredentialResolver — single seam for picking up Twenty creds.
 *
 * Env-var path only today:
 *   - `TWENTY_API_KEY` (required for dispatch to be wired)
 *   - `TWENTY_BASE_URL` (optional — when unset, `baseUrl` is undefined
 *     and callers supply their own fallback. The Atlas SaaS wiring in
 *     `ee/src/saas-crm` falls back to `https://crm.useatlas.dev`;
 *     self-hosters wire the plugin through `atlas.config.ts` and
 *     supply `baseUrl` explicitly.)
 *
 * Per-workspace DB-row precedence (`twenty_integrations`) will land
 * here next to the env path. Until then the resolver fails loud rather
 * than silently picking up the wrong workspace's credentials.
 */

export interface ResolvedTwentyCredentials {
  readonly apiKey: string;
  /** Undefined when `TWENTY_BASE_URL` is unset; caller picks a default. */
  readonly baseUrl: string | undefined;
}

/**
 * Actionable error — message tells the operator exactly which env var
 * to set. Distinct from a generic "credentials missing" so the boot-time
 * log makes the fix one line.
 */
export class TwentyCredentialError extends Error {
  override readonly name = "TwentyCredentialError";
  constructor(message: string) {
    super(message);
  }
}

export interface ResolveOptions {
  /**
   * Process env to read from. Tests pass a fresh object so they don't
   * mutate `process.env` across cases.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Strip trailing slashes without a polynomial-time regex.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Resolve credentials from the environment.
 *
 * @throws TwentyCredentialError if `TWENTY_API_KEY` is unset or empty.
 */
export function resolveCredentialsFromEnv(
  options: ResolveOptions = {},
): ResolvedTwentyCredentials {
  const env = options.env ?? process.env;
  const rawKey = env.TWENTY_API_KEY;
  if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
    throw new TwentyCredentialError(
      "Twenty credentials missing: set TWENTY_API_KEY (and optionally TWENTY_BASE_URL) in " +
        "the environment. Per-workspace credentials via Admin → Integrations → Twenty land " +
        "in a later slice.",
    );
  }
  const rawBase = env.TWENTY_BASE_URL;
  const baseUrl =
    typeof rawBase === "string" && rawBase.trim().length > 0
      ? stripTrailingSlashes(rawBase.trim())
      : undefined;
  return {
    apiKey: rawKey.trim(),
    baseUrl,
  };
}

/**
 * Best-effort variant — returns `null` instead of throwing when the
 * key is unset. Used at boot to decide whether the SaaS CRM dispatch
 * layer should run startup verification or short-circuit to disabled.
 */
export function tryResolveCredentialsFromEnv(
  options: ResolveOptions = {},
): ResolvedTwentyCredentials | null {
  try {
    return resolveCredentialsFromEnv(options);
  } catch (err) {
    if (err instanceof TwentyCredentialError) return null;
    throw err;
  }
}
