/**
 * Resolves Better Auth's `passkey.*` enrollment surface and the
 * `signIn.passkey()` action. The two are split because Better Auth mounts
 * enrollment under `passkey.*` and sign-in under `signIn.passkey` — a
 * future namespace shuffle on either side must not dark-mode the other
 * surface. Resolvers return `null` when the plugin isn't loaded so
 * callers can decide between a "refresh the page" banner and a thrown
 * error; user-visible copy stays in the consumer.
 */

import { authClient } from "./client";
import type { AuthApiResult, Passkey, PasskeySignIn } from "./wire-types";

export type { AuthApiError as PasskeyApiError, AuthApiResult as PasskeyApiResult, Passkey, PasskeySignIn, PasskeySignInData } from "./wire-types";

export interface PasskeyClient {
  addPasskey: (opts?: {
    name?: string;
    authenticatorAttachment?: "platform" | "cross-platform";
  }) => Promise<AuthApiResult<Passkey>>;
  listUserPasskeys: () => Promise<AuthApiResult<Passkey[]>>;
  updatePasskey: (opts: { id: string; name: string }) => Promise<AuthApiResult<{ passkey: Passkey }>>;
  deletePasskey: (opts: { id: string }) => Promise<AuthApiResult<{ status?: boolean }>>;
}

export function getPasskeyClient(): PasskeyClient | null {
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

export function getPasskeySignIn(): PasskeySignIn | null {
  const passkeySignIn = authClient.signIn.passkey;
  if (typeof passkeySignIn !== "function") {
    return null;
  }
  return passkeySignIn;
}
