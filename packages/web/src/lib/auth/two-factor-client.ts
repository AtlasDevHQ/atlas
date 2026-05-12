/**
 * Shared narrow view onto the Better Auth two-factor client surface.
 *
 * Better Auth's plugin-augmented type doesn't propagate `twoFactor.*`
 * through `createAuthClient` under TS6 strictness, so consumers cast
 * through `unknown`. Centralising the cast plus the runtime method-presence
 * guard means a renamed Better Auth method shows up as a precise null
 * here rather than a `TypeError` at click time.
 */

import { authClient } from "./client";

export interface TwoFactorApiError {
  message?: string;
  code?: string;
  status?: number;
}

/**
 * True XOR — narrowing on `error` reliably narrows `data`. The wrapper
 * `unwrapTwoFactorResult` depends on this; consumers should not need to
 * defensively check both fields.
 */
export type TwoFactorApiResult<T> =
  | { data: T; error: null }
  | { data: null; error: TwoFactorApiError };

export interface EnableResponse {
  totpURI: string;
  backupCodes: string[];
}

/**
 * Param shape shared by `verifyTotp` and `verifyBackupCode`. They behave
 * identically from the caller's perspective — `trustDevice` is honoured
 * server-side either way.
 */
export interface VerifyTwoFactorOpts {
  code: string;
  trustDevice?: boolean;
}

export interface TwoFactorClient {
  enable: (opts: { password: string }) => Promise<TwoFactorApiResult<EnableResponse>>;
  disable: (opts: { password: string }) => Promise<TwoFactorApiResult<{ status?: boolean }>>;
  verifyTotp: (opts: VerifyTwoFactorOpts) => Promise<TwoFactorApiResult<{ token?: string }>>;
  /** Each backup code is single-use — server invalidates on success. */
  verifyBackupCode: (opts: VerifyTwoFactorOpts) => Promise<TwoFactorApiResult<{ token?: string }>>;
  generateBackupCodes: (opts: {
    password: string;
  }) => Promise<TwoFactorApiResult<{ backupCodes: string[] }>>;
}

/**
 * Returns `null` when the plugin isn't loaded. Method-presence guard
 * catches Better Auth API drift at the boundary.
 */
export function getTwoFactorClient(): TwoFactorClient | null {
  // `authClient.twoFactor` is typed at the export boundary in
  // `lib/auth/client.ts`; the runtime guard still catches Better Auth
  // method renames at the boundary.
  const namespace = authClient.twoFactor;
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
 * configuration error. Thrown message is developer-facing.
 */
export function requireTwoFactorClient(): TwoFactorClient {
  const client = getTwoFactorClient();
  if (!client) {
    throw new Error("Better Auth twoFactor client plugin is not loaded");
  }
  return client;
}

export type TwoFactorOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; raw: TwoFactorApiError | null };

/**
 * Normalise a Better Auth result envelope into a tagged union. The
 * `{ data: null, error: null }` branch is the silent-success bug guard
 * (Better Auth occasionally produces this on 204-style responses); a
 * console breadcrumb fires so support can distinguish a wire-shape
 * anomaly from a normal failure.
 */
export function unwrapTwoFactorResult<T>(
  result: TwoFactorApiResult<T>,
  fallback: string,
): TwoFactorOutcome<T> {
  if (result.error) {
    return { ok: false, message: result.error.message ?? fallback, raw: result.error };
  }
  if (!result.data) {
    console.warn(
      "[two-factor] empty envelope — Better Auth returned { data: null, error: null }",
    );
    return {
      ok: false,
      message: fallback,
      raw: { code: "EMPTY_ENVELOPE", message: fallback },
    };
  }
  return { ok: true, data: result.data };
}
