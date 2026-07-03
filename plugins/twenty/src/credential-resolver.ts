/**
 * TwentyCredentialResolver — TWO seams, one per actor, no cross-actor
 * fallback.
 *
 * Two functions instead of "DB → env → throw" precedence so SaaS leaks
 * (#2850) are structurally impossible:
 *
 *   1. {@link resolveOperatorCredentials} — env-only. Reserved for
 *      `ee/src/saas-crm/`'s hardcoded lead-capture pipeline (Atlas
 *      signups/demo/sales-form → Atlas's own CRM). Never consults
 *      `twenty_integrations`.
 *
 *   2. {@link resolveWorkspaceCredentials} — DB-only, scoped to a
 *      workspace. NEVER falls back to env — `TWENTY_API_KEY` is
 *      platform-only and never participates in a plugin install
 *      (including Atlas's own team workspace). A missing row throws an
 *      actionable error pointing the user at Admin → Integrations →
 *      Twenty (or `atlas.config.ts` for self-hosted). `deployMode` is
 *      passed in so the thrown message tailors to the operator's
 *      install path.
 *
 * Why the split: with a single resolver that mixed env + DB, a future
 * change in `ee/saas-crm` consulting `twenty_integrations` would
 * silently route Atlas's lead capture to whichever workspace last
 * updated its Twenty row (Direction-2 leak). Symmetrically, a workspace
 * plugin action falling back to env would route a customer install at
 * Atlas's operator CRM (Direction-1 leak). The split makes both
 * unrepresentable — `ee/saas-crm` can't call the workspace function
 * (grep gate in `scripts/check-twenty-resolver-imports.sh`), and the
 * workspace function can't read env at all.
 *
 * Transport vs decrypt errors:
 *  - Transport (pg blip): swallowed; the workspace resolver throws
 *    {@link TwentyCredentialError} (no env fallback). The lookup logs
 *    structured-warn before throwing; this resolver stays log-free so
 *    it remains portable (no `@atlas/api` dep).
 *  - Decrypt (key rotation, corrupt ciphertext): always propagates as
 *    a {@link TwentyDecryptError} — silent env fallback would route to
 *    a different Twenty than the operator intended.
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
 * structured logs and metrics can attribute each dispatch to the
 * actor that produced its credentials (#2850).
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
   * Which resolver produced this record.
   * - `"db"` — per-workspace plugin install from `twenty_integrations`
   *   (returned by {@link resolveWorkspaceCredentials}).
   * - `"env"` — platform lead-capture from `TWENTY_API_KEY` env
   *   (returned by {@link resolveOperatorCredentials}).
   * Mixing sources within a single result is forbidden by #2850.
   */
  readonly source: "db" | "env";
}

/**
 * Actionable error — message tells the operator exactly which env var
 * to set OR points them at the admin UI. Distinct from a generic
 * "credentials missing" so the boot-time log makes the fix one line.
 *
 * Carries an optional `cause` chain so a transport-blip swallowed by
 * the resolver still surfaces in structured logs — callers should
 * `console.error(err)` (or pino's default `{ err }` serializer) which
 * traverses `Error.cause` automatically.
 */
export class TwentyCredentialError extends Error {
  override readonly name = "TwentyCredentialError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Decrypt-failure signal — a DB row exists but its ciphertext could
 * not be decrypted (key rotation, missing key version, corrupted
 * ciphertext). This is a deterministic misconfiguration; the resolver
 * must NOT silently fall back to env, because env would route to a
 * different Twenty instance than the operator intended.
 *
 * Production lookups (`getTwentyIntegrationWithSecret` in `@atlas/api`)
 * throw this when `decryptSecret` fails. The resolver re-throws it;
 * the dispatcher fails closed (dead-letters the outbox row or marks
 * unavailable at boot).
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
export function isTwentyDecryptError(
  err: unknown,
): err is TwentyDecryptError | { decryptFailed: true } {
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
 * The resolver swallows TRANSPORT errors and then THROWS
 * {@link TwentyCredentialError} (no env fallback ever). Decrypt
 * failures — flagged via {@link TwentyDecryptError} or any error with
 * `decryptFailed === true` — bubble up so the dispatcher can fail
 * closed.
 */
export type DbCredentialLookup = (
  workspaceId: string,
) => Promise<DbCredentialLookupResult | null>;

/**
 * Deploy mode discriminator passed to {@link resolveWorkspaceCredentials}.
 * Used only to tailor the "missing credentials" error message — both
 * modes are DB-only. The caller resolves this via `resolveDeployMode`
 * in `packages/api/src/lib/effect/deploy-mode.ts` and passes the value
 * in so the plugin stays portable (no `@atlas/api` back-import).
 */
export type DeployMode = "saas" | "self-hosted";

export interface ResolveWorkspaceOptions {
  /**
   * Tailors the thrown error message:
   *   `"saas"` — points the user at Admin → Integrations → Twenty.
   *   `"self-hosted"` — also mentions `atlas.config.ts`.
   *
   * Both modes are DB-only; `deployMode` does NOT enable an env
   * fallback. `TWENTY_API_KEY` is platform-only — no plugin install
   * (customer or Atlas's own team) ever reads from env.
   */
  readonly deployMode: DeployMode;
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

// ─────────────────────────────────────────────────────────────────────
//  Operator path — env-only, reserved for ee/src/saas-crm/
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve operator credentials from environment variables.
 *
 * **Caller restriction:** only `ee/src/saas-crm/` may import this
 * function. The `scripts/check-twenty-resolver-imports.sh` CI gate
 * fails when any other file imports it. This is the seam that keeps
 * Atlas-the-operator's `TWENTY_API_KEY` from leaking into per-workspace
 * dispatch paths (Direction-1 leak in #2850) or workspace plugin
 * credentials from being routed to Atlas's lead-capture pipeline
 * (Direction-2 leak).
 *
 * @throws {@link TwentyCredentialError} if `TWENTY_API_KEY` is unset or empty.
 */
export function resolveOperatorCredentials(
  options: ResolveOptions = {},
): ResolvedTwentyCredentials {
  const env = options.env ?? process.env;
  const rawKey = env.TWENTY_API_KEY;
  if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
    throw new TwentyCredentialError(
      "Twenty credentials missing: set TWENTY_API_KEY (and optionally TWENTY_BASE_URL) in " +
        "the environment. This env var is reserved for Atlas's own lead-capture pipeline; " +
        "per-workspace Twenty installs configure under Admin → Integrations → Twenty instead.",
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
 *
 * Same caller restriction as {@link resolveOperatorCredentials}; the
 * grep gate in `scripts/check-twenty-resolver-imports.sh` enumerates
 * both names (`resolveOperatorCredentials`, `tryResolveOperatorCredentials`)
 * explicitly — a future third operator-path helper must extend the
 * gate's pattern.
 */
export function tryResolveOperatorCredentials(
  options: ResolveOptions = {},
): ResolvedTwentyCredentials | null {
  try {
    return resolveOperatorCredentials(options);
  } catch (err) {
    if (err instanceof TwentyCredentialError) return null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Workspace path — DB-only, no env fallback
// ─────────────────────────────────────────────────────────────────────

function missingCredentialsMessage(deployMode: DeployMode): string {
  if (deployMode === "saas") {
    return (
      "Twenty credentials missing for this workspace: no row in twenty_integrations. " +
      "Configure Twenty under Admin → Integrations → Twenty. TWENTY_API_KEY is platform-only " +
      "and never participates in a plugin install (including Atlas's own team workspace)."
    );
  }
  return (
    "Twenty credentials missing for this workspace: no row in twenty_integrations. " +
    "Configure Twenty under Admin → Integrations → Twenty, or pass apiKey/baseUrl through " +
    "atlas.config.ts. TWENTY_API_KEY is platform-only — plugin installs read workspace " +
    "settings, never env."
  );
}

/**
 * Resolve credentials for a specific workspace. DB-only — never falls
 * back to env, regardless of `deployMode`.
 *
 *   - DB row present (valid apiKey) → returns DB creds (`source: "db"`).
 *   - DB row missing → throws {@link TwentyCredentialError} with an
 *     actionable message tailored to `deployMode`.
 *   - Transport error from the lookup → throws (same as missing row).
 *   - Decrypt error from the lookup → throws {@link TwentyDecryptError}
 *     so the dispatcher can fail closed.
 *
 * `deployMode` exists to tailor the thrown message; it does NOT enable
 * an env fallback in either mode. `TWENTY_API_KEY` is reserved for
 * `ee/src/saas-crm/`'s platform code path — no plugin install (customer
 * workspace, or Atlas's own team workspace) ever reads from env.
 *
 * @throws {@link TwentyCredentialError} when no usable row exists.
 * @throws {@link TwentyDecryptError} when the DB row's ciphertext fails
 *   to decrypt.
 */
export async function resolveWorkspaceCredentials(
  workspaceId: string,
  options: ResolveWorkspaceOptions,
): Promise<ResolvedTwentyCredentials> {
  let dbRow: DbCredentialLookupResult | null = null;
  // Track the swallowed transport error so we can attach it as `cause`
  // on the thrown TwentyCredentialError below. The lookup's own
  // structured-warn covers the production adapter; this preserves the
  // chain for caller-supplied lookups (tests, custom integrations)
  // that may not log before throwing.
  let lookupTransportError: unknown = undefined;
  if (options.lookup) {
    try {
      dbRow = await options.lookup(workspaceId);
    } catch (err) {
      if (isTwentyDecryptError(err)) {
        throw err;
      }
      // intentionally swallowed: transport blip. A transient failure
      // must NOT silently fall back to env (#2850) — surface the
      // missing-credentials error, but keep the original error as the
      // cause so it isn't lost from operator-visible logs.
      lookupTransportError = err;
      dbRow = null;
    }
  }

  if (dbRow) {
    const apiKey = trimNonEmpty(dbRow.apiKey);
    if (apiKey) {
      const baseUrlFromDb = trimNonEmpty(dbRow.baseUrl);
      const baseUrl: string | undefined = baseUrlFromDb
        ? assertTwentyBaseUrl(baseUrlFromDb)
        : undefined;
      return { apiKey, baseUrl, source: "db" };
    }
    // DB row exists but apiKey is empty/whitespace — treat as absent.
  }

  throw new TwentyCredentialError(
    missingCredentialsMessage(options.deployMode),
    lookupTransportError !== undefined ? { cause: lookupTransportError } : undefined,
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Back-compat re-exports — @deprecated
// ─────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use {@link resolveOperatorCredentials} (for `ee/src/saas-crm/`)
 *   or {@link resolveWorkspaceCredentials} (for everything else). This
 *   alias is preserved so existing self-hoster code that imports the
 *   pre-#2850 name keeps working; new code MUST pick the explicit actor.
 */
export const resolveCredentialsFromEnv = resolveOperatorCredentials;

/**
 * @deprecated Use {@link tryResolveOperatorCredentials} (for
 *   `ee/src/saas-crm/`). Preserved for back-compat only.
 */
export const tryResolveCredentialsFromEnv = tryResolveOperatorCredentials;

/**
 * @deprecated Use {@link ResolveWorkspaceOptions}.
 */
export interface ResolveForWorkspaceOptions {
  readonly lookup?: DbCredentialLookup;
}

/**
 * @deprecated Use {@link resolveWorkspaceCredentials} directly with an
 *   explicit `deployMode`. This shim defaults to `"self-hosted"` and
 *   resolves DB-only (no env fallback per #2850 — the pre-#2850
 *   "DB → env → throw" behavior is gone, callers must configure via
 *   admin UI or `atlas.config.ts`).
 */
export function resolveCredentialsForWorkspace(
  workspaceId: string,
  options: ResolveForWorkspaceOptions = {},
): Promise<ResolvedTwentyCredentials> {
  return resolveWorkspaceCredentials(workspaceId, {
    lookup: options.lookup,
    deployMode: "self-hosted",
  });
}
