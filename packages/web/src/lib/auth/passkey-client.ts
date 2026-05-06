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
 * The guard returns `null` when the plugin isn't loaded; callers decide
 * whether that is a soft "refresh the page" banner or a thrown error.
 * The user-visible message stays in the consumer — never include
 * developer paths in `Error` messages that bubble up to end users.
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

// ---------------------------------------------------------------------------
// Method surface — segregated into one interface so each consumer can
// destructure only what it needs (`const { addPasskey } = client`).
// ---------------------------------------------------------------------------

export interface PasskeyClient {
  addPasskey: (opts?: {
    name?: string;
    authenticatorAttachment?: "platform" | "cross-platform";
  }) => Promise<PasskeyApiResult<Passkey>>;
  listUserPasskeys: () => Promise<PasskeyApiResult<Passkey[]>>;
  updatePasskey: (opts: { id: string; name: string }) => Promise<PasskeyApiResult<{ passkey: Passkey }>>;
  deletePasskey: (opts: { id: string }) => Promise<PasskeyApiResult<{ status?: boolean }>>;
  /**
   * Initiates a passkey-first sign-in. With `autoFill: true` the call
   * subscribes the page to the OS conditional-UI picker rather than
   * triggering a modal prompt — pair it with an email input that has
   * `autocomplete="username webauthn"` so saved passkeys appear in the
   * autofill dropdown. Without `autoFill`, Better Auth fires the modal
   * authenticator prompt immediately (the "Sign in with passkey" CTA path).
   */
  signInPasskey: (opts?: {
    autoFill?: boolean;
  }) => Promise<PasskeyApiResult<PasskeySignInData>>;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Resolve the `passkey` namespace from authClient. Returns `null` when the
 * plugin isn't loaded — callers translate that into a user-facing surface
 * (banner / disabled tile / etc).
 *
 * Runtime method-presence check guards against Better Auth API drift —
 * a renamed method shows up as a precise null here rather than a
 * `TypeError: addPasskey is not a function` at click time.
 *
 * `signInPasskey` is resolved separately by {@link getPasskeySignIn} because
 * Better Auth mounts it under the top-level `signIn.passkey` namespace, not
 * under `passkey.*` — keeping the two guards apart prevents a renamed
 * `signIn.passkey` from disabling the security-page tile (or vice versa).
 */
export function getPasskeyClient(): PasskeyClient | null {
  // The cast is the documented workaround for Better Auth's plugin-inference
  // gap under TS6. Same pattern as `getTwoFactor()` in `two-factor-setup.tsx`
  // and the `@ts-expect-error` on `apiKeyClient()` in `client.ts`.
  const passkeyNamespace = (
    authClient as unknown as { passkey?: Partial<Omit<PasskeyClient, "signInPasskey">> }
  ).passkey;
  const signIn = getPasskeySignIn();
  if (
    !passkeyNamespace ||
    typeof passkeyNamespace.addPasskey !== "function" ||
    typeof passkeyNamespace.listUserPasskeys !== "function" ||
    typeof passkeyNamespace.updatePasskey !== "function" ||
    typeof passkeyNamespace.deletePasskey !== "function" ||
    !signIn
  ) {
    return null;
  }
  return {
    addPasskey: passkeyNamespace.addPasskey,
    listUserPasskeys: passkeyNamespace.listUserPasskeys,
    updatePasskey: passkeyNamespace.updatePasskey,
    deletePasskey: passkeyNamespace.deletePasskey,
    signInPasskey: signIn,
  };
}

/**
 * Resolve the `signIn.passkey()` action. Returns `null` when the plugin
 * isn't loaded — callers (login page, 2FA challenge page) translate that
 * into "passkey button hidden" rather than a hard error: a user without
 * the plugin still has email + password.
 */
export function getPasskeySignIn(): PasskeyClient["signInPasskey"] | null {
  const signInNamespace = (
    authClient as unknown as {
      signIn?: { passkey?: PasskeyClient["signInPasskey"] };
    }
  ).signIn;
  if (!signInNamespace || typeof signInNamespace.passkey !== "function") {
    return null;
  }
  return signInNamespace.passkey;
}
