/**
 * Shared narrow view onto the Better Auth passkey client surface.
 *
 * `createAuthClient`'s plugin-augmented type doesn't surface
 * `passkey.{addPasskey,listUserPasskeys,deletePasskey,updatePasskey}` or
 * `signIn.passkey()` through the generic chain under TS6 strictness, so
 * consumers cast through `unknown`. Centralising the cast plus the runtime
 * guard here keeps the security-page components and the login flow honest
 * about which methods they depend on.
 *
 * The guards return `null` when the plugin isn't loaded; callers decide
 * whether that is a soft "refresh the page" banner or a thrown error.
 * The user-visible message stays in the consumer — never include
 * developer paths in `Error` messages that bubble up to end users.
 *
 * `PasskeyClient` and `PasskeySignIn` are intentionally split: Better Auth
 * mounts enrollment endpoints under `passkey.*` and sign-in under
 * `signIn.passkey`, and a future namespace shuffle on either side must
 * not dark-mode the other surface.
 */

import { authClient } from "./client";

// ---------------------------------------------------------------------------
// Wire shapes — match Better Auth's actual return contract
// ---------------------------------------------------------------------------

export interface PasskeyApiError {
  message?: string;
  code?: string;
  status?: number;
}

export type PasskeyApiResult<T> = {
  data: T | null;
  error: PasskeyApiError | null;
};

export interface Passkey {
  id: string;
  name?: string;
  createdAt: Date | string;
}

/**
 * The `signIn.passkey()` success envelope. Better Auth populates `data` with
 * `{ session, user }` once the WebAuthn assertion verifies; we narrow to
 * `Record<string, unknown>` because the page only needs to know the call
 * succeeded — routing decisions stay in the page itself.
 */
export interface PasskeySignInData {
  session: Record<string, unknown>;
  user: Record<string, unknown>;
}

export interface PasskeyClient {
  addPasskey: (opts?: {
    name?: string;
    authenticatorAttachment?: "platform" | "cross-platform";
  }) => Promise<PasskeyApiResult<Passkey>>;
  listUserPasskeys: () => Promise<PasskeyApiResult<Passkey[]>>;
  updatePasskey: (opts: { id: string; name: string }) => Promise<PasskeyApiResult<{ passkey: Passkey }>>;
  deletePasskey: (opts: { id: string }) => Promise<PasskeyApiResult<{ status?: boolean }>>;
}

/**
 * Initiates a passkey-first sign-in. With `autoFill: true` the call
 * subscribes the page to the OS conditional-UI picker rather than
 * triggering a modal prompt — pair it with an email input that has
 * `autocomplete="username webauthn"` so saved passkeys appear in the
 * autofill dropdown. Without `autoFill`, Better Auth fires the modal
 * authenticator prompt immediately (the "Sign in with passkey" CTA path).
 */
export type PasskeySignIn = (opts?: {
  autoFill?: boolean;
}) => Promise<PasskeyApiResult<PasskeySignInData>>;

/**
 * Resolve the `passkey` namespace from authClient. Returns `null` when
 * enrollment endpoints aren't loaded — the security page translates that
 * into a "refresh the page" banner. Independent of `getPasskeySignIn` so
 * a renamed `signIn.passkey` doesn't dark-mode admin enrollment.
 *
 * The runtime method-presence check catches Better Auth API drift — a
 * renamed method surfaces as a precise null rather than a
 * `TypeError: addPasskey is not a function` at click time.
 */
export function getPasskeyClient(): PasskeyClient | null {
  // `authClient.passkey` is typed at the export boundary in
  // `lib/auth/client.ts` so the read is now compile-time safe; the runtime
  // method-presence check still surfaces Better Auth API drift as a precise
  // null rather than a `TypeError` at click time.
  const namespace = authClient.passkey;
  if (
    !namespace ||
    typeof namespace.addPasskey !== "function" ||
    typeof namespace.listUserPasskeys !== "function" ||
    typeof namespace.updatePasskey !== "function" ||
    typeof namespace.deletePasskey !== "function"
  ) {
    return null;
  }
  return namespace as PasskeyClient;
}

/**
 * Resolve the `signIn.passkey()` action. Returns `null` when the plugin
 * isn't loaded — callers (login page, 2FA challenge page) translate that
 * into "passkey button hidden" rather than a hard error: a user without
 * the plugin still has email + password.
 */
export function getPasskeySignIn(): PasskeySignIn | null {
  const passkeySignIn = authClient.signIn.passkey;
  if (typeof passkeySignIn !== "function") {
    return null;
  }
  return passkeySignIn as PasskeySignIn;
}
