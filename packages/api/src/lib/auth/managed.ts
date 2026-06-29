/**
 * Managed auth (Better Auth) — session validation.
 *
 * Checks cookies and bearer tokens via auth.api.getSession().
 * Returns AuthResult on success or missing session (never throws for
 * "no session" — returns { authenticated: false } instead).
 * Throws on infrastructure errors (DB unavailable, etc.);
 * callers (middleware.ts) are expected to catch.
 */

import type { AuthResult, AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { parseRole, capRole } from "@atlas/api/lib/auth/permissions";
import { getAuthInstance, SESSION_ORIGIN_CLI } from "@atlas/api/lib/auth/server";
import { isEffectivelyBanned } from "@atlas/api/lib/auth/admin-user-ops";
import { resolveEffectiveRole } from "@atlas/api/lib/auth/effective-role";
import {
  API_KEY_MARKER_CLAIM,
  parseApiKeyMetadata,
} from "@atlas/api/lib/auth/api-key-metadata";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getSetting } from "@atlas/api/lib/settings";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("auth:managed");

/**
 * The header carrying a workspace-scoped API key. Mirrors the Better Auth
 * `apiKey()` plugin's default `apiKeyHeaders` (`x-api-key`). Lower-cased to match
 * `Headers.get` normalization. Kept as a named const so the detection seam below
 * and the plugin config in `server.ts` can't drift to different headers.
 */
export const API_KEY_HEADER = "x-api-key";

export async function validateManaged(req: Request): Promise<AuthResult> {
  const auth = getAuthInstance();

  const session = await auth.api.getSession({ headers: req.headers });

  if (!session) {
    log.debug("getSession returned null — no valid session");
    return { authenticated: false, mode: "managed", status: 401, error: "Not signed in" };
  }

  const userId = session.user?.id;
  const email = session.user?.email;
  if (!userId) {
    log.error({ sessionExists: true }, "Session found but user.id is missing");
    return { authenticated: false, mode: "managed", status: 500, error: "Session data is incomplete" };
  }

  // Extract the merged effective role from the session user. Set by the
  // `customSession` plugin in `server.ts`, which already runs
  // `resolveEffectiveRole(user.role, member.role)` on every getSession.
  // Reading the stamped field here avoids a second identical member-table
  // SELECT per request. Falls back to the raw `role` (system-wide,
  // admin plugin) for unit tests that mock auth.api.getSession without
  // routing through the customSession callback.
  const sessionUser = session.user as Record<string, unknown>;

  // #3159 — per-request ban enforcement (defense-in-depth). The removed Better
  // Auth admin plugin rejected banned users only at session-CREATE; we reproduce
  // that create-time guard in server.ts and `banUserDirect` deletes the banned
  // user's live sessions. This read-side check is the third layer: it rejects a
  // banned user whose ban is visible on a fresh getSession read. `banned`/
  // `banExpires` ride along on the getSession user via `additionalFields`; an
  // expired ban (banExpires in the past) is treated as lifted.
  //
  // NOTE the bound: Better Auth serves the cookie-cache snapshot on a cache hit
  // (up to `cookieCache.maxAge`, default 30s — see SESSION_COOKIE_CACHE_*), so
  // this check reflects ban state as of the last fresh read, not strictly the
  // current row. Primary eviction is `banUserDirect`'s session delete; this
  // catches a banned user who still has a live session once the read refreshes.
  if (
    isEffectivelyBanned(
      sessionUser?.banned as boolean | null | undefined,
      sessionUser?.banExpires as string | Date | null | undefined,
      Date.now(),
    )
  ) {
    log.info({ userId }, "Rejecting session — user is banned");
    return { authenticated: false, mode: "managed", status: 401, error: "Account is banned" };
  }

  // #4046 / ADR-0027 §6 — workspace-scoped API key (unattended CI). When the
  // request carried an `x-api-key` header, the Better Auth `apiKey()` plugin
  // already resolved it to its OWNING member (the session.user above is that
  // real person — never a synthetic identity), but the synthetic session it
  // builds carries no `activeOrganizationId`/`origin`/metadata. Enrich from the
  // key's metadata so the key resolves through the same actor path + gate chain
  // as the device-flow bearer: bound org, org-role-only role (capped at the
  // mint-time ceiling), the member's RLS claim, and a distinct `api_key` marker.
  // The non-api-key (cookie / device-flow bearer) path falls through unchanged.
  //
  // Returning HERE intentionally bypasses the interactive-session idle/absolute
  // timeout block below: those govern human sessions, whereas an unattended key's
  // lifetime control is its OWN `expiresIn` expiry (enforced live by
  // `verifyApiKey` in `resolveApiKeyAuth`). The ban check above still applies to
  // the owning member; only the idle/absolute timeouts are replaced by key expiry.
  if (req.headers.get(API_KEY_HEADER)) {
    // The apiKey() plugin's `verifyApiKey` (server-only) isn't on the base Auth
    // type the instance is annotated as (plugin endpoints are reached through the
    // HTTP handler), so narrow to the structural shape resolveApiKeyAuth needs.
    return resolveApiKeyAuth(req, auth as unknown as AuthWithApiKey, userId, email);
  }

  const stampedRole = sessionUser?.effectiveRole ?? sessionUser?.role;
  // Better Auth can store roles as comma-separated strings; Atlas uses only the first.
  const rawRole = typeof stampedRole === "string" ? stampedRole.split(",")[0].trim() : stampedRole;
  let role: ReturnType<typeof parseRole>;
  if (typeof rawRole === "string") {
    role = parseRole(rawRole);
    if (rawRole && !role) {
      log.warn({ value: rawRole, validRoles: ["member", "admin", "owner"] }, "Session user role is not a valid Atlas role — defaulting to 'member'");
    }
  } else {
    role = undefined;
    if (rawRole !== undefined && rawRole !== null) {
      log.warn({ type: typeof rawRole }, "Session user role is not a string — ignoring");
    }
  }

  const sessionData = session.session as Record<string, unknown> | undefined;

  // Extract activeOrganizationId from session — set by Better Auth org plugin
  // via POST /organization/set-active. Resolved BEFORE timeout enforcement so
  // the workspace tier of the workspace-scoped timeout keys applies (#3406):
  // the timeouts govern the workspace the session is operating in.
  const activeOrganizationId = (sessionData?.activeOrganizationId as string) ?? undefined;

  // Session timeout enforcement (idle + absolute)
  if (sessionData) {
    const now = Date.now();

    const idleRaw = parseInt(getSetting("ATLAS_SESSION_IDLE_TIMEOUT", activeOrganizationId) ?? "0", 10);
    const idleTimeout = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : 0;
    if (idleTimeout > 0 && sessionData.updatedAt) {
      const updatedAt = new Date(sessionData.updatedAt as string).getTime();
      if (Number.isNaN(updatedAt)) {
        log.warn({ userId, updatedAt: sessionData.updatedAt }, "Session updatedAt is not a valid date — rejecting session");
        return { authenticated: false, mode: "managed", status: 401, error: "Session data is invalid" };
      }
      if (now - updatedAt > idleTimeout * 1000) {
        log.info({ userId, idleMs: now - updatedAt, idleTimeout }, "Session idle timeout exceeded");
        return { authenticated: false, mode: "managed", status: 401, error: "Session expired (idle timeout)" };
      }
    }

    const absRaw = parseInt(getSetting("ATLAS_SESSION_ABSOLUTE_TIMEOUT", activeOrganizationId) ?? "0", 10);
    const absoluteTimeout = Number.isFinite(absRaw) && absRaw > 0 ? absRaw : 0;
    if (absoluteTimeout > 0 && sessionData.createdAt) {
      const createdAt = new Date(sessionData.createdAt as string).getTime();
      if (Number.isNaN(createdAt)) {
        log.warn({ userId, createdAt: sessionData.createdAt }, "Session createdAt is not a valid date — rejecting session");
        return { authenticated: false, mode: "managed", status: 401, error: "Session data is invalid" };
      }
      if (now - createdAt > absoluteTimeout * 1000) {
        log.info({ userId, ageMs: now - createdAt, absoluteTimeout }, "Session absolute timeout exceeded");
        return { authenticated: false, mode: "managed", status: 401, error: "Session expired" };
      }
    }
  }

  const passkeyCount = await resolvePasskeyCount(userId);

  // Computed fields land AFTER the spread so a session-user field can't
  // shadow our authoritative claims (asserted in managed.test.ts).
  const claims: Record<string, unknown> = { ...sessionUser, sub: userId, passkeyCount };
  if (activeOrganizationId) {
    claims.org_id = activeOrganizationId;
  }
  // #4044 / ADR-0025 §5 — surface the session's `origin` marker (set on the
  // `session` row by the ADR-0026 device-flow session.create hook in server.ts,
  // only ever `'cli'`) so origin-aware consumers (the admin
  // audit trail) can record `origin=cli` without re-reading the session.
  // Lives on `session.session` (sessionData), not `session.user`. Set/cleared
  // here AFTER the `...sessionUser` spread (like `sub`/`passkeyCount`) so the
  // session ROW is the sole authority — a stray session-user `origin` field
  // can never shadow it. Surfaced RAW (unvalidated) into the generic claims
  // bag; consumers must narrow/validate it (the admin audit does so via
  // `isRequestOrigin` against the canonical origin vocabulary).
  const sessionOrigin = sessionData?.origin;
  if (typeof sessionOrigin === "string" && sessionOrigin.length > 0) {
    claims.origin = sessionOrigin;
  } else {
    delete claims.origin;
  }

  return {
    authenticated: true,
    mode: "managed",
    user: createAtlasUser(userId, "managed", email || userId, { role, activeOrganizationId, claims }),
  };
}

// `::int` cast keeps PG's bigint COUNT(*) as a JS number — pg surfaces
// bigint as a string by default. Returns 0 on missing DB / read failure:
// fail-closed gates passkey-only users on infra blips, which is strictly
// safer than admitting them on a stale read.
async function resolvePasskeyCount(userId: string): Promise<number> {
  if (!hasInternalDB()) return 0;
  try {
    const rows = await internalQuery<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM passkey WHERE "userId" = $1`,
      [userId],
    );
    return rows[0]?.count ?? 0;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId },
      "Failed to look up passkey count — treating as 0",
    );
    return 0;
  }
}

/**
 * Minimal shape of the Better Auth instance the API-key path needs — the
 * server-only `verifyApiKey` endpoint, which returns the key (incl. its parsed
 * `metadata`) for a raw key string. Typed structurally so the unit tests can
 * inject a stub without standing up Better Auth.
 */
interface AuthWithApiKey {
  api: {
    verifyApiKey: (args: {
      body: { key: string };
    }) => Promise<{
      valid?: boolean;
      key?: { metadata?: unknown; userId?: string; referenceId?: string } | null;
    } | null>;
  };
}

/**
 * Resolve a workspace-scoped API-key request (#4046 / ADR-0027 §6) into an
 * authenticated `AuthResult`.
 *
 * Preconditions (asserted by the caller): the request carried an `x-api-key`
 * header and the Better Auth `apiKey()` plugin resolved it to its owning member
 * (`userId`/`email` from `getSession`, after the ban check). This reads the key's
 * metadata and produces an AtlasUser that resolves through the SAME gate chain as
 * the device-flow bearer:
 *  - **real owning member** — `userId` is the key owner, never a synthetic
 *    identity (the audit log traces a leaked key to a person + scope).
 *  - **bound org** — `activeOrganizationId` from metadata; the request body never
 *    carries an org field (isolation derives from the credential).
 *  - **org-role-only, capped at the mint ceiling** — the LIVE member role is
 *    re-resolved (`resolveEffectiveRole(undefined, …)`, the cli-downgrade model:
 *    a `platform_admin` owner's key never carries cross-tenant god-mode) and
 *    capped at the role stored at mint time, so a later promotion can't widen the
 *    key and a demotion down-privileges it.
 *  - **RLS claim** — the member's claims from metadata are merged into the claims
 *    bag so RLS-enabled workspaces filter rows (ADR-0027 §3), rather than
 *    fail-closed-blocking a legitimate key.
 *  - **distinct actor marker** — `claims.api_key = true` (read by the execute-sql
 *    route to stamp `actor_kind = "api_key"`); `claims.origin = "cli"` (the
 *    transport, a valid approval origin).
 *
 * Fails closed (401) when the key metadata is missing/malformed — a key minted
 * without the workspace binding can't safely resolve an org.
 */
export async function resolveApiKeyAuth(
  req: Request,
  auth: AuthWithApiKey,
  userId: string,
  email: string | undefined,
): Promise<AuthResult> {
  const key = req.headers.get(API_KEY_HEADER);
  if (!key) {
    // Defensive — the caller only routes here when the header is present.
    return { authenticated: false, mode: "managed", status: 401, error: "API key required" };
  }

  let rawMetadata: unknown;
  let keyOwner: string | undefined;
  try {
    // `getSession` already resolved the OWNING member (it built the api-key
    // session) — but `verifyApiKey` is the AUTHORITATIVE live read: it returns the
    // key's metadata bag AND re-checks validity against the current row, so a
    // revocation takes effect on the NEXT request (the cookie-cache snapshot the
    // session path may serve can't mask it). Both calls are therefore needed —
    // identity from the session, scope + live validity from verify.
    const verified = await auth.api.verifyApiKey({ body: { key } });
    // ALLOW-LIST, not deny-one: require an explicit `valid === true`. A response
    // with `valid` absent/non-boolean, or `verified === null`, fails closed here
    // rather than relying on the downstream metadata gate to catch it — so a
    // future plugin soft-failure shape (`{ valid: undefined, key: {...} }`)
    // can't be admitted.
    if (!verified || verified.valid !== true) {
      return { authenticated: false, mode: "managed", status: 401, error: "API key is invalid or revoked" };
    }
    rawMetadata = verified.key?.metadata;
    keyOwner = verified.key?.userId ?? verified.key?.referenceId;
  } catch (err) {
    log.error(
      { err: errorMessage(err), userId },
      "verifyApiKey threw while resolving a workspace API key — failing closed",
    );
    return { authenticated: false, mode: "managed", status: 401, error: "API key could not be verified" };
  }

  // Defense-in-depth: the audited actor identity comes from `getSession`
  // (`userId`), the scope from the verified key. If a request presented BOTH a
  // session cookie (user A) AND an `x-api-key` (user B's key) and the cookie won
  // `getSession`, we'd otherwise bind user A's identity to user B's key scope —
  // breaking the "a leaked key traces to its owner" invariant.
  //
  // #4110 AC4 — the binding is REQUIRED, not best-effort: a verified key whose
  // owner can't be determined (`verifyApiKey` returned `valid:true` but neither
  // `userId` nor `referenceId`) must fail closed, NOT fall through trusting the
  // cookie/bearer `userId`. A real Better Auth key always carries an owner; a
  // missing one signals a malformed/forged verify shape we won't bind to a
  // person. Both the "no owner" and "owner mismatch" cases fail closed.
  if (!keyOwner) {
    log.error(
      { userId },
      "verifyApiKey reported valid but resolved no key owner — failing closed (cannot bind the actor to a person)",
    );
    return { authenticated: false, mode: "managed", status: 401, error: "API key could not be verified" };
  }
  if (keyOwner !== userId) {
    log.error(
      { userId, keyOwner },
      "API key owner does not match the resolved session user — failing closed (possible cookie+key credential mix)",
    );
    return { authenticated: false, mode: "managed", status: 401, error: "API key could not be verified" };
  }

  const metadata = parseApiKeyMetadata(rawMetadata);
  if (!metadata) {
    log.warn(
      { userId },
      "Workspace API key has no valid metadata binding — refusing (a key must carry its bound workspace)",
    );
    return { authenticated: false, mode: "managed", status: 401, error: "API key is not bound to a workspace" };
  }

  const orgId = metadata.orgId;

  // Role resolution — fail-closed and re-resolved LIVE, never trusting the
  // stored role as a floor:
  //  - `resolveEffectiveRole(undefined, …)` is the cli downgrade: it withholds
  //    any user-level role (a platform_admin owner's key never carries
  //    cross-tenant authority) and reads the LIVE member.role for this org.
  //  - With an internal DB present, that live lookup is AUTHORITATIVE. If the
  //    owner is no longer a member of this org (removed) it returns `undefined`,
  //    and the key resolves to NO elevated role — the stored `metadata.role` is
  //    only a CEILING (cap), never a fallback that would re-grant authority to a
  //    removed member.
  //  - Only with NO internal DB (single-tenant self-host, no member table) is
  //    there no live signal, so the mint-time `metadata.role` stands.
  const liveRole = await resolveEffectiveRole(undefined, userId, orgId);
  let role: AtlasRole | undefined;
  if (!hasInternalDB()) {
    role = metadata.role;
  } else if (liveRole !== undefined && metadata.role !== undefined) {
    // Cap the live role at the mint ceiling: a key minted by an admin later
    // promoted to owner stays admin-capped; a demotion lowers it live.
    role = capRole(liveRole, metadata.role);
  } else {
    // Live lookup is authoritative — a removed member resolves to no role.
    role = liveRole;
  }

  // Claims bag: the member's RLS claim values from metadata + the standard
  // identity claims, PLUS the cli transport origin and the distinct api-key
  // marker. Identity/marker claims land AFTER the metadata-claims spread so a
  // stray metadata claim named `sub`/`org_id`/`origin`/`api_key` can't shadow
  // the authoritative values.
  const claims: Record<string, unknown> = {
    ...(metadata.claims ?? {}),
    sub: userId,
    org_id: orgId,
    origin: SESSION_ORIGIN_CLI,
    [API_KEY_MARKER_CLAIM]: true,
  };

  const user: AtlasUser = createAtlasUser(userId, "managed", email || userId, {
    ...(role !== undefined ? { role } : {}),
    activeOrganizationId: orgId,
    claims,
  });

  return { authenticated: true, mode: "managed", user };
}
