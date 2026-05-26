/**
 * TwentyCredentialResolver — single seam for picking up Twenty creds.
 *
 * Resolution order (per #2732 / Slice 7):
 *   1. Per-workspace row in `twenty_integrations` (admin UI override)
 *   2. `TWENTY_API_KEY` env var
 *   3. Throw with an actionable message
 *
 * The DB-row path is opt-in: callers provide a {@link DbCredentialLookup}
 * callback that returns the decrypted credential row (or `null` when no
 * row exists). The resolver itself doesn't touch Postgres — the lookup
 * lives in `@atlas/api/lib/integrations/twenty/credentials.ts` so the
 * plugin stays portable (no `@atlas/api` import).
 *
 * Fail-open on lookup errors: a transient pg blip falls back to env so
 * the SaaS demo dispatcher keeps working when the credential table is
 * temporarily unreachable. Only when BOTH the DB lookup AND env are
 * absent do we throw — that's a real misconfiguration the operator
 * needs to see.
 */

export interface ResolvedTwentyCredentials {
  readonly apiKey: string;
  /** Undefined when neither DB row nor `TWENTY_BASE_URL` supplies one. */
  readonly baseUrl: string | undefined;
}

/**
 * Actionable error — message tells the operator exactly which env var
 * to set OR points them at the admin UI. Distinct from a generic
 * "credentials missing" so the boot-time log makes the fix one line.
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
 * The shape of a decrypted credential row from `twenty_integrations`.
 * `baseUrl` is nullable because the column is nullable — operator can
 * configure the API key without a custom baseUrl and let the env value
 * (or caller-supplied default) take over.
 */
export interface DbCredentialLookupResult {
  readonly apiKey: string;
  readonly baseUrl: string | null;
}

/**
 * Callback that fetches the per-workspace credential row. Returns
 * `null` when no row exists; throws on transport / decrypt failure.
 *
 * The resolver swallows thrown errors and falls back to env so a pg
 * blip doesn't take down the dispatcher (the DB-row path is an
 * optional override, not a hard requirement).
 */
export type DbCredentialLookup = (
  workspaceId: string,
) => Promise<DbCredentialLookupResult | null>;

export interface ResolveForWorkspaceOptions extends ResolveOptions {
  readonly lookup?: DbCredentialLookup;
}

/**
 * Strip trailing slashes without a polynomial-time regex.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Trim + reject empty / whitespace-only strings. */
function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
        "the environment, or configure them under Admin → Integrations → Twenty.",
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

/**
 * Resolve credentials for a specific workspace, honoring the
 * Slice 7 (#2732) precedence: DB row → env → throw.
 *
 * `options.lookup` is the DB seam. Production passes
 * `lookupTwentyDbCredentials` from `@atlas/api/lib/integrations/twenty/credentials`;
 * tests pass an in-memory stub.
 *
 * Omitting `lookup` collapses to the env-only path, preserving the
 * back-compat shape for callers that don't (yet) have the workspace
 * context wired through.
 *
 * @throws TwentyCredentialError when neither path yields a usable key.
 */
export async function resolveCredentialsForWorkspace(
  workspaceId: string,
  options: ResolveForWorkspaceOptions = {},
): Promise<ResolvedTwentyCredentials> {
  // ── 1. DB row override ─────────────────────────────────────────────
  // Fail-open: a pg blip falls back to env so the SaaS demo dispatcher
  // keeps working when the credential table is briefly unreachable.
  let dbRow: DbCredentialLookupResult | null = null;
  if (options.lookup) {
    try {
      dbRow = await options.lookup(workspaceId);
    } catch {
      // Swallow — env is the documented fallback. The caller's logger
      // wraps the lookup with structured-warn on failure; the resolver
      // itself stays log-free so it remains portable (no @atlas/api).
      dbRow = null;
    }
  }

  if (dbRow) {
    const apiKey = trimNonEmpty(dbRow.apiKey);
    if (apiKey) {
      const baseUrlFromDb = trimNonEmpty(dbRow.baseUrl);
      if (baseUrlFromDb) {
        return { apiKey, baseUrl: stripTrailingSlashes(baseUrlFromDb) };
      }
      // DB row's baseUrl is null/empty — fall back to env-supplied baseUrl
      // (apiKey still comes from DB). The env apiKey is NOT consulted —
      // the DB row's apiKey wins by design.
      const env = options.env ?? process.env;
      const rawBase = env.TWENTY_BASE_URL;
      const envBase =
        typeof rawBase === "string" && rawBase.trim().length > 0
          ? stripTrailingSlashes(rawBase.trim())
          : undefined;
      return { apiKey, baseUrl: envBase };
    }
    // DB row exists but apiKey is empty/whitespace — fall through to env.
  }

  // ── 2. Env fallback ───────────────────────────────────────────────
  // `resolveCredentialsFromEnv` already throws TwentyCredentialError
  // with the right shape when env is also unset, so we let it bubble.
  return resolveCredentialsFromEnv(options);
}
