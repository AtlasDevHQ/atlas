/**
 * Shared narrow view onto the Better Auth passkey client surface.
 *
 * `createAuthClient`'s plugin-augmented type doesn't surface
 * `passkey.{addPasskey,listUserPasskeys,deletePasskey,updatePasskey}` through
 * the generic chain under TS6 strictness, so consumers cast through
 * `unknown`. Centralising the cast plus the runtime guard here keeps the
 * three security-page components (`passkey-tile`, `passkey-list`,
 * `security/page.tsx`) honest about which methods they depend on.
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
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * Resolve the `passkey` namespace from authClient. Returns `null` when the
 * plugin isn't loaded — callers translate that into a user-facing surface
 * (banner / disabled tile / etc).
 *
 * Runtime method-presence check guards against Better Auth API drift —
 * a renamed method shows up as a precise null here rather than a
 * `TypeError: addPasskey is not a function` at click time.
 */
export function getPasskeyClient(): PasskeyClient | null {
  // The cast is the documented workaround for Better Auth's plugin-inference
  // gap under TS6. Same pattern as `getTwoFactor()` in `two-factor-setup.tsx`
  // and the `@ts-expect-error` on `apiKeyClient()` in `client.ts`.
  const namespace = (authClient as unknown as { passkey?: Partial<PasskeyClient> })
    .passkey;
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
