/**
 * TwentyCredentialResolver — single seam for picking up Twenty creds.
 *
 * Resolution order:
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
 * Fail-open on TRANSPORT errors: a transient pg blip falls back to env
 * so the SaaS demo dispatcher keeps working when the credential table
 * is temporarily unreachable. A lookup MUST distinguish transport from
 * decrypt by throwing a `decryptFailed`-flagged error (any object with
 * `decryptFailed === true` on it) for the latter — those bubble up and
 * fail closed at the dispatch boundary so a key-rotation misconfig
 * doesn't silently route credentials to the env fallback.
 *
 * Only when BOTH the DB lookup AND env are absent do we throw — that's
 * a real misconfiguration the operator needs to see.
 */

/**
 * Branded apiKey — a `string` that has passed the bearer-token gate at
 * a parse boundary (Zod or {@link assertTwentyApiKey}). The brand makes
 * a `baseUrl` ↔ `apiKey` swap a compile error rather than a runtime
 * embarrassment.
 *
 * Same pattern as `WorkspaceId` / `ChannelId` / `ThreadId` in
 * `@useatlas/types` — see #2680 for the precedent.
 */
export type TwentyApiKey = string & { readonly __brand: "TwentyApiKey" };

/**
 * Branded Twenty REST base URL. Validated as a well-formed URL with
 * `http://` or `https://` scheme before the brand is applied.
 */
export type TwentyBaseUrl = string & { readonly __brand: "TwentyBaseUrl" };

/** Assert + brand a string as a non-empty TwentyApiKey. */
export function assertTwentyApiKey(value: string): TwentyApiKey {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TwentyCredentialError("Twenty apiKey is empty");
  }
  return trimmed as TwentyApiKey;
}

/**
 * Assert + brand a string as a TwentyBaseUrl. Accepts both `https://`
 * and `http://` (dev / private-network deployments use plain http);
 * rejects everything else and any string that fails URL parsing.
 */
export function assertTwentyBaseUrl(value: string): TwentyBaseUrl {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TwentyCredentialError(
      `Twenty baseUrl is not a well-formed URL: ${trimmed}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TwentyCredentialError(
      `Twenty baseUrl must use https or http scheme; got ${parsed.protocol}`,
    );
  }
  return stripTrailingSlashes(trimmed) as TwentyBaseUrl;
}

/**
 * Resolved Twenty credentials, with a `source` discriminator so
 * dispatch-time consumers can attribute creds to the admin-UI override
 * vs the env fallback in structured logs and metrics.
 *
 * Plain `string` types here (not the {@link TwentyApiKey} /
 * {@link TwentyBaseUrl} brands) because the brand's value is at the
 * VALIDATION boundary (Zod parse, `assertTwentyApiKey`) — once a
 * credential survives validation, plain strings flow through cleanly
 * without ceremony in tests / downstream callers.
 */
export interface ResolvedTwentyCredentials {
  readonly apiKey: string;
  /** Undefined when neither DB row nor `TWENTY_BASE_URL` supplies one. */
  readonly baseUrl: string | undefined;
  /**
   * Which resolution path produced this record.
   * - `"db"` — admin-UI row in `twenty_integrations`.
   * - `"env"` — `TWENTY_API_KEY` (+ optional `TWENTY_BASE_URL`).
   */
  readonly source: "db" | "env";
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

/**
 * Decrypt-failure signal — a DB row exists but its ciphertext could
 * not be decrypted (key rotation, missing key version, corrupted
 * ciphertext). This is a deterministic misconfiguration; the resolver
 * must NOT silently fall back to env, because env would route to a
 * different Twenty instance than the operator intended.
 *
 * Production lookups (`getTwentyIntegrationWithSecret`,
 * `findLatestTwentyDbCredentials` in `@atlas/api`) throw this when
 * `decryptSecret` fails. The resolver re-throws it; the dispatcher
 * fails closed (dead-letters the outbox row or marks unavailable at
 * boot).
 */
export class TwentyDecryptError extends Error {
  override readonly name = "TwentyDecryptError";
  readonly decryptFailed = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Type-guard for the decrypt-failure signal — accepts subclasses and structural marks. */
export function isTwentyDecryptError(err: unknown): boolean {
  if (err instanceof TwentyDecryptError) return true;
  if (typeof err === "object" && err !== null && "decryptFailed" in err) {
    return (err as { decryptFailed?: unknown }).decryptFailed === true;
  }
  return false;
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
 * The resolver swallows TRANSPORT errors and falls back to env so a pg
 * blip doesn't take down the dispatcher (the DB-row path is an optional
 * override, not a hard requirement). Decrypt failures — flagged via
 * `TwentyDecryptError` or any error with `decryptFailed === true` —
 * bubble up so the dispatcher can fail closed.
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
  const apiKey: string = assertTwentyApiKey(rawKey);
  const rawBase = env.TWENTY_BASE_URL;
  const baseUrl: string | undefined =
    typeof rawBase === "string" && rawBase.trim().length > 0
      ? assertTwentyBaseUrl(rawBase)
      : undefined;
  return { apiKey, baseUrl, source: "env" };
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
 * Resolve credentials for a specific workspace. Precedence:
 * DB row → env → throw.
 *
 * `options.lookup` is the DB seam. Production passes
 * `lookupTwentyDbCredentials` from `@atlas/api/lib/integrations/twenty/credentials`;
 * tests pass an in-memory stub.
 *
 * Omitting `lookup` collapses to the env-only path, preserving the
 * back-compat shape for callers that don't (yet) have the workspace
 * context wired through.
 *
 * Decrypt failures from `options.lookup` propagate as-is so the
 * dispatcher can fail closed; transport failures (anything else) are
 * swallowed and the resolver falls through to env.
 *
 * @throws TwentyCredentialError when neither path yields a usable key.
 * @throws TwentyDecryptError when the DB row's ciphertext fails to decrypt.
 *
 * @internal Wired through to the agent-tool path lands with #2849
 *   (`crm_outbox.workspace_id`). Today's SaaS dispatch path consults
 *   `findLatestTwentyDbCredentials` directly because outbox rows don't
 *   yet carry a workspaceId.
 */
export async function resolveCredentialsForWorkspace(
  workspaceId: string,
  options: ResolveForWorkspaceOptions = {},
): Promise<ResolvedTwentyCredentials> {
  // ── 1. DB row override ─────────────────────────────────────────────
  // Fail-open on TRANSPORT errors: a pg blip falls back to env so the
  // SaaS demo dispatcher keeps working when the credential table is
  // briefly unreachable. Fail-CLOSED on decrypt errors: a row exists,
  // its ciphertext doesn't decrypt, env would be the wrong destination
  // — the operator must see that.
  let dbRow: DbCredentialLookupResult | null = null;
  if (options.lookup) {
    try {
      dbRow = await options.lookup(workspaceId);
    } catch (err) {
      if (isTwentyDecryptError(err)) {
        // intentionally re-thrown: a decrypt failure is operator-visible
        // misconfiguration (key rotation / corrupt ciphertext); silently
        // falling back to env would route to the wrong Twenty.
        throw err;
      }
      // intentionally ignored: transport blip — env is the documented
      // fallback. The store (production lookup) emits the structured-warn
      // before throwing; the resolver stays log-free so it remains
      // portable (no `@atlas/api` dep).
      void err;
      dbRow = null;
    }
  }

  if (dbRow) {
    const apiKey = trimNonEmpty(dbRow.apiKey);
    if (apiKey) {
      const baseUrlFromDb = trimNonEmpty(dbRow.baseUrl);
      if (baseUrlFromDb) {
        const baseUrl: string = assertTwentyBaseUrl(baseUrlFromDb);
        return { apiKey, baseUrl, source: "db" };
      }
      // DB row's baseUrl is null/empty — fall back to env-supplied baseUrl
      // (apiKey still comes from DB). The env apiKey is NOT consulted —
      // the DB row's apiKey wins by design.
      const env = options.env ?? process.env;
      const rawBase = env.TWENTY_BASE_URL;
      const envBase: string | undefined =
        typeof rawBase === "string" && rawBase.trim().length > 0
          ? assertTwentyBaseUrl(rawBase)
          : undefined;
      return { apiKey, baseUrl: envBase, source: "db" };
    }
    // DB row exists but apiKey is empty/whitespace — fall through to env.
  }

  // ── 2. Env fallback ───────────────────────────────────────────────
  // `resolveCredentialsFromEnv` already throws TwentyCredentialError
  // with the right shape when env is also unset, so we let it bubble.
  return resolveCredentialsFromEnv(options);
}
