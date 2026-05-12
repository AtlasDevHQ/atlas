/**
 * Wire-shape contracts for Better Auth plugin namespaces, defined once so
 * the boundary type in `client.ts` and the per-plugin helpers
 * (`passkey-client.ts`, `two-factor-client.ts`) reference the same return
 * shapes. Without this file the boundary type and the helper-local types
 * drift, which forces `as PasskeyClient` / `as PasskeySignIn` casts at
 * the helper return statements.
 */

export interface AuthApiError {
  message?: string;
  code?: string;
  status?: number;
}

export type AuthApiResult<T> = {
  data: T | null;
  error: AuthApiError | null;
};

// ── passkey ────────────────────────────────────────────────────────────

export interface Passkey {
  id: string;
  name?: string;
  createdAt: Date | string;
}

export interface PasskeySignInData {
  session: Record<string, unknown>;
  user: Record<string, unknown>;
}

export type PasskeySignIn = (opts?: {
  autoFill?: boolean;
}) => Promise<AuthApiResult<PasskeySignInData>>;
