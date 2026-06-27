/**
 * Better Auth React client.
 *
 * Imported from page.tsx. The useSession() hook runs in all auth modes
 * but session data is only meaningful when authMode === "managed".
 * Bearer tokens are handled server-side by the bearer plugin;
 * browser sessions use cookies automatically.
 *
 * Base URL resolution priority:
 *   1. getApiUrl()               — the regional override if set, else the
 *                                  build-time NEXT_PUBLIC_ATLAS_API_URL (the
 *                                  cross-origin API host when frontend ≠ API)
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
  deviceAuthorizationClient,
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
import type { AuthApiResult, Passkey, PasskeySignIn } from "./wire-types";

function getBaseURL(): string {
  const url = getApiUrl();
  if (url) return url + "/api/auth";
  if (typeof window !== "undefined") return window.location.origin + "/api/auth";
  return "http://localhost:3000/api/auth";
}

// The auth client targets whatever `getApiUrl()` resolves at import. Under
// ADR-0024 identity is regional, so for a returning user whose `atlas_region`
// cookie is already set, api-url.ts restores it on import (before this
// module-level singleton is built) and the client targets that workspace's own
// regional API — where its session cookie was minted host-only (§5 — no
// `Domain=.useatlas.dev`, so the session is non-portable across regions). With
// no region signal it's the build-time default. `credentials: "include"` (below)
// lets the browser store and send that host-only cookie on same-site,
// cross-origin calls from `app.useatlas.dev`. Persisting the selection during
// signup and consuming the region key on login land in follow-up slices; until
// then only a cookie left by a prior session takes effect. Region is never
// discovered post-auth by calling the US API — that circular path is retired
// (#3971).
const _authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [
    apiKeyClient(),
    // #3159 — the `adminClient()` mirror was removed alongside the server
    // `admin()` plugin. Nothing in the web app calls `authClient.admin.*`
    // (user management goes through the platform_admin-gated REST routes under
    // `/api/v1/admin/*`), so dropping the client plugin removes dead surface.
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
    // #4043 / ADR-0026 — device-authorization client mirror gives us
    // `authClient.device.{approve,deny}` for the /device approval page that
    // backs `atlas login`.
    deviceAuthorizationClient(),
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

// Better Auth types these timestamps as `Date`, but over JSON the client
// actually receives ISO strings. Accept `string | Date` so both BA's
// declared type (which newer TS toolchains surface straight through the
// `as OrgClient` overrides) and the runtime value type-check; render sites
// treat the runtime value as an ISO string (`RelativeTimestamp`, `new
// Date(...)`).
export interface OrgInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: InvitationStatus;
  inviterId: string;
  expiresAt: string | Date;
  createdAt: string | Date;
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

// User extras the server's `customSession` plugin stamps on every
// `getSession`. `effectiveRole` is max(user.role, active-org member.role)
// — read by `useUserRole` so org-admins (whose `user.role` is the default
// "user") see admin chrome.
type UserFieldExtras = {
  effectiveRole?: string | null;
};

type BaseUseSessionReturn = ReturnType<typeof _authClient.useSession>;
type BaseUseSessionData = NonNullable<BaseUseSessionReturn["data"]>;
type WidenedUseSessionReturn = Omit<BaseUseSessionReturn, "data"> & {
  data:
    | (Omit<BaseUseSessionData, "session" | "user"> & {
        session: BaseUseSessionData["session"] & SessionFieldExtras;
        user: BaseUseSessionData["user"] & UserFieldExtras;
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
  // Better Auth returns `{ redirect, url }` on success (the post-consent
  // redirect target is `url`, not the older `redirectURI`).
  oauth2?: {
    consent: (opts: { accept: boolean; scope?: string }) => Promise<{
      data?: { redirect: boolean; url: string };
      error?: { message?: string };
    } | undefined>;
  };

  // deviceAuthorizationClient contributes `device.{approve,deny}` for the
  // /device approval screen that backs `atlas login` (#4043 / ADR-0026).
  // Unlike oauth2/passkey/etc., this namespace survives the client-chain
  // inference, so it is NOT re-declared here — the device page reads the
  // inferred `{ error, error_description }` result via `deviceErrorMessage`.

  // emailOTPClient — verify + resend used by post-signup interstitial.
  emailOtp?: {
    verifyEmail: (opts: { email: string; otp: string }) => Promise<AuthApiResult<unknown>>;
    sendVerificationOtp: (opts: { email: string; type: "email-verification" }) => Promise<AuthApiResult<unknown>>;
  };

  // stripeClient({ subscription: true }) — org-scoped billing (#3417).
  // Atlas subscriptions are organization-scoped, so every call passes
  // `customerType: "organization"`; the server's `authorizeReference`
  // gates the referenced org (admin/owner for money-moving actions).
  // `error.code` carries the plugin's structured codes (e.g.
  // CUSTOMER_NOT_FOUND, UNAUTHORIZED) — branch on those, not on copy.
  subscription?: {
    billingPortal?: (opts: {
      referenceId?: string;
      customerType?: "user" | "organization";
      returnUrl?: string;
      disableRedirect?: boolean;
    }) => Promise<{
      data?: { url: string; redirect: boolean } | null;
      error?: { message?: string; code?: string; status?: number } | null;
    }>;
    // First subscription → Stripe Checkout redirect URL; plan change on an
    // existing subscription → Billing Portal subscription_update_confirm
    // URL (or the returnUrl when the plugin applied the change directly).
    // Pass scheduleAtPeriodEnd for downgrades so the switch lands at the
    // period boundary via a Subscription Schedule (#3418).
    upgrade?: (opts: {
      plan: string;
      referenceId?: string;
      customerType?: "user" | "organization";
      annual?: boolean;
      seats?: number;
      successUrl?: string;
      cancelUrl?: string;
      returnUrl?: string;
      scheduleAtPeriodEnd?: boolean;
      disableRedirect?: boolean;
    }) => Promise<{
      data?: { url?: string | null; redirect: boolean } | null;
      error?: { message?: string; code?: string; status?: number } | null;
    }>;
  };
};
export const authClient: OrgClient = _authClient as OrgClient;
