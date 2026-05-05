/**
 * Shared narrow view onto the Better Auth two-factor client surface.
 *
 * `createAuthClient`'s plugin-augmented type doesn't surface
 * `twoFactor.{enable,disable,verifyTotp,verifyBackupCode,generateBackupCodes}`
 * through the generic chain under TS6 strictness, so consumers cast through
 * `unknown`. Centralising the cast plus the runtime guard keeps the security
 * page (`two-factor-setup`) and the sign-in challenge page
 * (`/login/two-factor`) honest about which methods they depend on.
 *
 * Mirrors the shape of `passkey-client.ts` — same null-on-missing convention
 * for callers that want to soft-fail, same throwing helper for callers that
 * treat plugin absence as a configuration error.
 */

import { authClient } from "./client";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface TwoFactorApiError {
  message?: string;
  code?: string;
  status?: number;
}

export type TwoFactorApiResult<T> = {
  data: T | null;
  error: TwoFactorApiError | null;
};

export interface EnableResponse {
  totpURI: string;
  backupCodes: string[];
}

// ---------------------------------------------------------------------------
// Method surface — the union of what both consumers need.
// ---------------------------------------------------------------------------

export interface TwoFactorClient {
  enable: (opts: { password: string }) => Promise<TwoFactorApiResult<EnableResponse>>;
  disable: (opts: { password: string }) => Promise<TwoFactorApiResult<{ status?: boolean }>>;
  /**
   * Used both during enrollment (no `trustDevice`, session already exists)
   * and during sign-in challenge (with `trustDevice` checkbox state). The
   * server flow is unified — see Better Auth's `verify-two-factor.mjs`.
   */
  verifyTotp: (opts: {
    code: string;
    trustDevice?: boolean;
  }) => Promise<TwoFactorApiResult<{ token?: string }>>;
  /**
   * Sign-in fallback when the user has lost access to their authenticator.
   * Each backup code is single-use — a successful call invalidates it
   * server-side and the next call will fail.
   */
  verifyBackupCode: (opts: {
    code: string;
    trustDevice?: boolean;
  }) => Promise<TwoFactorApiResult<{ token?: string }>>;
  generateBackupCodes: (opts: {
    password: string;
  }) => Promise<TwoFactorApiResult<{ backupCodes: string[] }>>;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Resolve the `twoFactor` namespace off authClient, returning `null` if the
 * plugin isn't loaded. Method-presence guard catches Better Auth API drift
 * (renamed methods turn into a precise null instead of a `TypeError` at
 * click time).
 */
export function getTwoFactorClient(): TwoFactorClient | null {
  // The cast is the documented workaround for Better Auth's plugin-inference
  // gap under TS6. Same pattern as `getPasskeyClient()` in `passkey-client.ts`
  // and the `@ts-expect-error` on `apiKeyClient()` in `client.ts`.
  const namespace = (authClient as unknown as { twoFactor?: Partial<TwoFactorClient> })
    .twoFactor;
  if (
    !namespace ||
    typeof namespace.enable !== "function" ||
    typeof namespace.disable !== "function" ||
    typeof namespace.verifyTotp !== "function" ||
    typeof namespace.verifyBackupCode !== "function" ||
    typeof namespace.generateBackupCodes !== "function"
  ) {
    return null;
  }
  return namespace as TwoFactorClient;
}

/**
 * Throwing variant for callers that treat plugin absence as a startup-time
 * configuration error — matches the existing `getTwoFactor()` ergonomics in
 * `two-factor-setup.tsx`. The thrown message is developer-facing; UI layers
 * should convert to user-friendly copy before display.
 */
export function requireTwoFactorClient(): TwoFactorClient {
  const client = getTwoFactorClient();
  if (!client) {
    throw new Error(
      "Better Auth twoFactor client plugin is not loaded — check packages/web/src/lib/auth/client.ts",
    );
  }
  return client;
}

// ---------------------------------------------------------------------------
// Result narrowing
// ---------------------------------------------------------------------------

/**
 * Normalise a Better Auth result envelope into a tagged union. Necessary
 * because the wire shape allows `{ data: null, error: null }` (e.g. an
 * unexpected 204) which would otherwise be silently treated as success.
 *
 * The `raw` field on the failure variant carries the structured error so
 * callers can log `code` / `status` for support without surfacing them in
 * end-user UI.
 */
export type TwoFactorOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; raw: TwoFactorApiError | null };

export function unwrapTwoFactorResult<T>(
  result: TwoFactorApiResult<T>,
  fallback: string,
): TwoFactorOutcome<T> {
  if (result.error) {
    return { ok: false, message: result.error.message ?? fallback, raw: result.error };
  }
  if (!result.data) {
    return { ok: false, message: fallback, raw: null };
  }
  return { ok: true, data: result.data };
}
