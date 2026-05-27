/**
 * Better Auth React client.
 *
 * Imported from page.tsx. The useSession() hook runs in all auth modes
 * but session data is only meaningful when authMode === "managed".
 * Bearer tokens are handled server-side by the bearer plugin;
 * browser sessions use cookies automatically.
 *
 * Base URL resolution priority:
 *   1. NEXT_PUBLIC_ATLAS_API_URL — cross-origin API (set when frontend and API are separate)
 *   2. window.location.origin    — same-origin fallback (browser)
 *   3. http://localhost:3000      — SSR / prerender fallback
 *
 * A full URL is required for SSR compatibility — relative "/api/auth" fails
 * during Next.js static prerendering because there's no host to resolve against.
 */

import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import { stripeClient } from "@better-auth/stripe/client";
// @better-auth/oauth-provider client mirror — gives us
// `authClient.oauth2.consent()` for the /oauth2/consent page (#2024).
// The same plugin handles passing the signed `oauth_query` through every
// in-flow request automatically.
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
// @better-auth/passkey client mirror — gives us
// `authClient.passkey.{addPasskey, listUserPasskeys, deletePasskey, updatePasskey}`
// for the enrollment UI on /admin/account-security. The server plugin is
// loaded unconditionally next to twoFactor().
import { passkeyClient } from "@better-auth/passkey/client";
import {
  adminClient,
  emailOTPClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
// Reuse the org plugin's own type exports rather than hand-rolling shapes
// — keeps OrgInvitation in lockstep with Better Auth's row schema.
import type { InvitationStatus } from "better-auth/plugins/organization";

// Better Auth's org-plugin error code keys. The runtime const
// `ORGANIZATION_ERROR_CODES` is not re-exported from the plugin's public
// surface (lives under `dist/plugins/organization/error-codes.mjs`), so
// mirror just the codes we branch on here. A typo in a consumer is caught
// at compile time via the `OrgErrorCode` union below.
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { ac, owner, admin, member } from "./org-permissions";
import { adminAccessControl, adminRole, platformAdminRole } from "./admin-permissions";
import type { AuthApiResult, Passkey, PasskeySignIn } from "./wire-types";

function getBaseURL(): string {
  const url = getApiUrl();
  if (url) return url + "/api/auth";
  if (typeof window !== "undefined") return window.location.origin + "/api/auth";
  return "http://localhost:3000/api/auth";
}

// Auth always authenticates against the global API (not the regional endpoint).
// The client is a module-level singleton created at import time, before
// setRegionalApiUrl() is called. This is intentional: session cookies and
// auth operations stay on the global endpoint; only data-plane calls (chat,
// admin fetches) switch to the regional API after settings load.
const _authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [
    // @ts-expect-error — TS6 strictness breaks apiKeyClient plugin type; runtime types are correct
    apiKeyClient(),
    adminClient({
      ac: adminAccessControl,
      roles: {
        admin: adminRole,
        platform_admin: platformAdminRole,
      },
    }),
    organizationClient({
      ac,
      roles: { owner, admin, member },
    }),
    // Two-factor (TOTP + backup codes). Server plugin is loaded
    // unconditionally; the client mirror gives us authClient.twoFactor.*
    // for the enrollment UI in /admin/account-security.
    twoFactorClient(),
    // Passkey (WebAuthn). Server plugin lives next to twoFactor().
    passkeyClient(),
    // Email OTP — replaces magic-link verification with an 8-character
    // code. Adds `authClient.emailOtp.sendVerificationOtp({ email, type })`
    // and `authClient.emailOtp.verifyEmail({ email, otp })` to the
    // client surface. Server plugin is configured in buildPlugins().
    emailOTPClient(),
    stripeClient({ subscription: true }),
    oauthProviderClient(),
  ],
  // Cross-origin deployments (app.useatlas.dev → api.useatlas.dev) require
  // credentials: "include" so the browser stores and sends session cookies.
  fetchOptions: isCrossOrigin() ? { credentials: "include" as RequestCredentials } : {},
});

// `createAuthClient` erases each plugin's namespace contribution under TS6
// strictness. Patch the holes at this export boundary so consumers read a
// typed surface instead of writing `(authClient as unknown as { ... })` per
// call. Method presence stays optional so the runtime guards in
// `lib/auth/{passkey,two-factor}-client.ts` and the OTP/consent forms
// still surface Better Auth API drift as a precise null rather than a
// `TypeError` at click time. Wire shapes (`AuthApiResult`, `Passkey`,
// `PasskeySignIn`) live in `./wire-types` so the helpers and this boundary
// reference identical types.
//
// `code` on `OrgResult.error` carries Better Auth's structured error code
// so callers branch on a stable enum instead of substring-matching
// localized English copy. `OrgErrorCode | string` keeps unknown codes
// flowing through without a cast (future BA additions).
export type OrgErrorCode =
  | "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"
  | "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION"
  | "INVITATION_NOT_FOUND"
  | "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"
  | "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION";
export type OrgResult<T> = {
  data: T | null;
  error: { message: string; code?: OrgErrorCode | string; status?: number } | null;
};

// Re-export Better Auth's status union so consumers have one import site.
// Adding a new state in BA becomes a TS error at every consumer that
// switches on it.
export type { InvitationStatus } from "better-auth/plugins/organization";

// Better Auth's exported `Invitation` carries `Date` for timestamps; over
// JSON those serialize as ISO strings. Keep the shape aligned with BA but
// widen date fields to `string` to match what the client actually
// receives.
export interface OrgInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: InvitationStatus;
  inviterId: string;
  expiresAt: string;
  createdAt: string;
}

// `getInvitation` returns the row plus inviter / organization metadata so
// the /accept-invitation page can render "You were invited by X to Y"
// without a second roundtrip.
export interface OrgInvitationDetail extends OrgInvitation {
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string;
}

// Session extras the organization plugin stamps at runtime (active-org id is
// written by `databaseHooks.session.create.before` in
// `packages/api/src/lib/auth/server.ts`; the active-org name comes from the
// plugin's own `setActive` flow). The client-side `useSession()` inferred
// return doesn't see them.
type SessionFieldExtras = {
  activeOrganizationId?: string;
  activeOrganizationName?: string;
};

type BaseUseSessionReturn = ReturnType<typeof _authClient.useSession>;
type BaseUseSessionData = NonNullable<BaseUseSessionReturn["data"]>;
type WidenedUseSessionReturn = Omit<BaseUseSessionReturn, "data"> & {
  data:
    | (Omit<BaseUseSessionData, "session"> & {
        session: BaseUseSessionData["session"] & SessionFieldExtras;
      })
    | null;
};

// `useSession` is the one method we replace (rather than intersection-add)
// because we're widening its return; intersection would produce an
// unsatisfiable overload. Every other plugin-namespace patch below stays
// intersection-add.
type OrgClient = Omit<typeof _authClient, "useSession"> & {
  useSession: () => WidenedUseSessionReturn;

  // Better Auth core — present at runtime, lost through plugin chain.
  updateUser?: (opts: { name?: string }) => Promise<{ error?: { message?: string } | null }>;

  // organizationClient — typed manually since the chain inference loses it.
  organization: {
    create: (opts: { name: string; slug: string; logo?: string }) => Promise<OrgResult<{ id: string }>>;
    list: () => Promise<OrgResult<{ id: string; name: string; slug: string; logo?: string | null }[]>>;
    setActive: (opts: { organizationId: string }) => Promise<OrgResult<Record<string, unknown>>>;
    // Server hooks live in `lib/auth/server.ts:organizationHooks`. The org
    // plugin enforces the `invitation:create` ACL.
    inviteMember: (opts: { email: string; role: string; organizationId?: string; resend?: boolean }) => Promise<OrgResult<OrgInvitation>>;
    cancelInvitation: (opts: { invitationId: string }) => Promise<OrgResult<{ id: string }>>;
    acceptInvitation: (opts: { invitationId: string }) => Promise<OrgResult<{ invitation: OrgInvitation; member: { id: string; userId: string; organizationId: string; role: string } }>>;
    rejectInvitation: (opts: { invitationId: string }) => Promise<OrgResult<{ invitation: OrgInvitation }>>;
    getInvitation: (opts: { query: { id: string } }) => Promise<OrgResult<OrgInvitationDetail>>;
    listInvitations: (opts?: { query?: { organizationId?: string } }) => Promise<OrgResult<OrgInvitation[]>>;
    listUserInvitations: () => Promise<OrgResult<OrgInvitation[]>>;
  };

  // passkeyClient — enrollment lives under `passkey.*`; sign-in lives
  // under `signIn.passkey` (declared on the signIn intersection below).
  passkey?: {
    addPasskey?: (opts?: {
      name?: string;
      authenticatorAttachment?: "platform" | "cross-platform";
    }) => Promise<AuthApiResult<Passkey>>;
    listUserPasskeys?: () => Promise<AuthApiResult<Passkey[]>>;
    updatePasskey?: (opts: { id: string; name: string }) => Promise<AuthApiResult<{ passkey: Passkey }>>;
    deletePasskey?: (opts: { id: string }) => Promise<AuthApiResult<{ status?: boolean }>>;
  };
  signIn: (typeof _authClient)["signIn"] & {
    passkey?: PasskeySignIn;
  };

  // twoFactorClient — TOTP + backup codes.
  twoFactor?: {
    enable?: (opts: { password: string }) => Promise<AuthApiResult<{ totpURI: string; backupCodes: string[] }>>;
    disable?: (opts: { password: string }) => Promise<AuthApiResult<{ status?: boolean }>>;
    verifyTotp?: (opts: { code: string; trustDevice?: boolean }) => Promise<AuthApiResult<{ token?: string }>>;
    verifyBackupCode?: (opts: { code: string; trustDevice?: boolean }) => Promise<AuthApiResult<{ token?: string }>>;
    generateBackupCodes?: (opts: { password: string }) => Promise<AuthApiResult<{ backupCodes: string[] }>>;
  };

  // oauthProviderClient — `oauth2.consent` resolves the consent screen.
  oauth2?: {
    consent: (opts: { accept: boolean; scope?: string }) => Promise<{
      data?: { redirectURI?: string };
      error?: { message?: string };
    } | undefined>;
  };

  // emailOTPClient — verify + resend used by post-signup interstitial.
  emailOtp?: {
    verifyEmail: (opts: { email: string; otp: string }) => Promise<AuthApiResult<unknown>>;
    sendVerificationOtp: (opts: { email: string; type: "email-verification" }) => Promise<AuthApiResult<unknown>>;
  };
};
export const authClient: OrgClient = _authClient as OrgClient;
