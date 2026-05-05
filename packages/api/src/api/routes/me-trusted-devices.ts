/**
 * `/api/v1/admin/me/trusted-devices` — per-user list + revoke for trust-device
 * cookies (the "Trust this browser for 30 days" opt-in on the 2FA challenge).
 *
 * Mounted directly on the parent `admin` router rather than a sub-router so it
 * lives under `admin.ts`'s `adminAuthAndContext()` per-handler auth WITHOUT the
 * `mfaRequired` gate — by definition a user managing trust grants might not
 * have an MFA factor enrolled (they could be revoking the last one). Same
 * carve-out as `/me/password-status` and `/me/password`.
 *
 * Two routes:
 *   GET    /me/trusted-devices              — list calling user's grants
 *   DELETE /me/trusted-devices/{identifier} — revoke a specific grant
 *
 * Authorization: callers may only see / mutate rows where `value = userId` on
 * the verification row AND `user_id = userId` on the trusted_device row. Both
 * filters are required — relaxing either is an IDOR. Platform admins are NOT
 * special-cased here; cross-user revoke is a separate platform-admin concern.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { extractTrustDeviceIdentifier } from "@atlas/api/lib/auth/trust-device-cookie";
import {
  getInternalDB,
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import { authErrorCode } from "./admin-auth";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

// Re-exported for the audit route's existing callers (tests, the C.2
// admin route module). New consumers should import directly from
// `@atlas/api/lib/auth/trust-device-cookie`.
export { extractTrustDeviceIdentifier };

const log = createLogger("me-trusted-devices");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TrustedDeviceSchema = z.object({
  // Tightened to match the DB invariant: identifier is the
  // `trust-device-<random>` payload Better Auth wrote to verification.
  // The shared `.startsWith` constraint catches a wire-shape regression
  // where some other verification row (email-verify, 2FA-cookie) leaks
  // into the response.
  identifier: z.string().min(1).max(255).startsWith("trust-device-"),
  deviceLabel: z.string().nullable(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  isCurrent: z.boolean(),
});

const ListTrustedDevicesResponse = z.object({
  devices: z.array(TrustedDeviceSchema),
});

// Same upper bound as session ids in admin-sessions.ts — generous enough for
// Better Auth's `trust-device-${randomString(32)}` (≈45 chars) without giving
// adversarial inputs room to bloat audit metadata or query plans.
const ID_MAX_LEN = 255;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/me/trusted-devices",
  tags: ["Admin — Trusted Devices"],
  summary: "List your trusted browsers",
  description:
    "Returns the calling user's active trust-device grants — browsers where " +
    "the user opted in to skip the 2FA challenge for the configured trust " +
    "window. Expired and revoked grants do not appear.",
  responses: {
    200: {
      description: "Trust-grant list",
      content: { "application/json": { schema: ListTrustedDevicesResponse } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — requires managed auth", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/me/trusted-devices/{identifier}",
  tags: ["Admin — Trusted Devices"],
  summary: "Revoke a trusted browser",
  description:
    "Revokes a single trust grant. The next request from that browser will " +
    "be challenged for 2FA. Atomic across the verification row (the cookie " +
    "Better Auth checks) and our metadata row.",
  request: {
    params: z.object({
      identifier: z
        .string()
        .min(1)
        .max(ID_MAX_LEN)
        .openapi({ param: { name: "identifier", in: "path" }, example: "trust-device-abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Trust grant revoked",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No such grant for this user", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Mounts GET + DELETE `/me/trusted-devices` on the admin router. */
export function registerTrustedDeviceRoutes(
  admin: OpenAPIHono,
  reqId: (c: { get(key: string): unknown }) => string,
): void {
  admin.openapi(listRoute, async (c) => {
    const requestId = reqId(c);
    let authResult;
    try {
      authResult = await authenticateRequest(c.req.raw);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId },
        "Authentication system error in trusted-devices list",
      );
      return c.json(
        { error: "auth_error", message: "Authentication system error", requestId },
        500,
      );
    }
    if (!authResult.authenticated) {
      const code = authErrorCode(authResult.error);
      return c.json({ error: code, message: authResult.error, requestId }, authResult.status);
    }
    if (authResult.mode !== "managed" || !authResult.user) {
      return c.json(
        { error: "not_available", message: "Trust-device management requires managed auth mode.", requestId },
        404,
      );
    }
    if (!hasInternalDB()) {
      // Managed mode without internal DB shouldn't happen at runtime (auth
      // tables live in DATABASE_URL), but the guard avoids a confusing
      // "ECONNREFUSED" if an operator misconfigures.
      return c.json({ devices: [] }, 200);
    }

    const userId = authResult.user.id;
    const cookieHeader = c.req.raw.headers.get("cookie");
    const currentIdentifier = extractTrustDeviceIdentifier(cookieHeader);

    try {
      // INNER JOIN — only surface grants whose verification row still exists
      // and hasn't expired. `verification.expiresAt` is the source of truth;
      // an expired row remains in trusted_device until a future cleanup pass
      // but should never appear in the list (otherwise users would see
      // grants that no longer skip 2FA).
      const rows = await internalQuery<{
        identifier: string;
        device_label: string | null;
        user_agent: string | null;
        ip_address: string | null;
        created_at: string;
        expires_at: string;
      }>(
        `SELECT td.identifier,
                td.device_label,
                td.user_agent,
                td.ip_address,
                td.created_at,
                v."expiresAt" AS expires_at
         FROM trusted_device td
         INNER JOIN verification v ON v.identifier = td.identifier
         WHERE td.user_id = $1
           AND v."expiresAt" > NOW()
         ORDER BY td.created_at DESC`,
        [userId],
      );

      return c.json(
        {
          devices: rows.map((r) => ({
            identifier: r.identifier,
            deviceLabel: r.device_label,
            userAgent: r.user_agent,
            ipAddress: r.ip_address,
            createdAt: new Date(r.created_at).toISOString(),
            expiresAt: new Date(r.expires_at).toISOString(),
            isCurrent: r.identifier === currentIdentifier,
          })),
        },
        200,
      );
    } catch (err) {
      log.error(
        { err: errorMessage(err), userId, requestId },
        "Failed to list trusted devices",
      );
      return c.json(
        { error: "internal_error", message: "Could not load trusted browsers. Please retry.", requestId },
        500,
      );
    }
  });

  admin.openapi(deleteRoute, async (c) => {
    const requestId = reqId(c);
    const { identifier } = c.req.valid("param");

    let authResult;
    try {
      authResult = await authenticateRequest(c.req.raw);
    } catch (err) {
      log.error(
        { err: errorMessage(err), requestId },
        "Authentication system error in trusted-devices revoke",
      );
      return c.json(
        { error: "auth_error", message: "Authentication system error", requestId },
        500,
      );
    }
    if (!authResult.authenticated) {
      const code = authErrorCode(authResult.error);
      return c.json({ error: code, message: authResult.error, requestId }, authResult.status);
    }
    if (authResult.mode !== "managed" || !authResult.user) {
      return c.json(
        { error: "not_available", message: "Trust-device management requires managed auth mode.", requestId },
        404,
      );
    }
    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "Trust-device management requires an internal database.", requestId },
        404,
      );
    }

    const userId = authResult.user.id;
    const pool = getInternalDB();
    const client = await pool.connect();
    let deleted: boolean;
    let rollbackErr: Error | null = null;
    try {
      await client.query("BEGIN");

      // Verification first — that's the cookie Better Auth checks, so a
      // partial-failure window where the cookie still works is the worst
      // outcome. After cookie rotation only the verification row may match;
      // before it lands, only the trusted_device row may exist. Either delete
      // is sufficient — both filters carry the IDOR check (`value = $userId`
      // and `user_id = $userId` respectively), preventing a caller from
      // revoking another user's grant by guessing the identifier.
      const verRes = await client.query(
        `DELETE FROM verification WHERE identifier = $1 AND value = $2`,
        [identifier, userId],
      );

      const tdRes = await client.query(
        `DELETE FROM trusted_device WHERE identifier = $1 AND user_id = $2`,
        [identifier, userId],
      );

      // node-pg's rowCount isn't on InternalPoolClient's narrow shape — read defensively.
      const verCount = (verRes as unknown as { rowCount?: number }).rowCount ?? 0;
      const tdCount = (tdRes as unknown as { rowCount?: number }).rowCount ?? 0;
      deleted = verCount > 0 || tdCount > 0;

      await client.query("COMMIT");
    } catch (err) {
      // ROLLBACK can itself fail (TCP reset between BEGIN and ROLLBACK). pg
      // destroys the socket when `release(err)` is called with a truthy arg,
      // so a poisoned client doesn't return to the pool to corrupt the next
      // borrower's transaction.
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        log.warn(
          { err: rollbackErr.message, requestId },
          "ROLLBACK failed after trusted-device revoke error — client will be destroyed",
        );
      });
      log.error(
        { err: errorMessage(err), userId, requestId, identifier },
        "Failed to revoke trusted device",
      );
      return c.json(
        { error: "internal_error", message: "Could not revoke this browser. Please retry.", requestId },
        500,
      );
    } finally {
      client.release(rollbackErr ?? undefined);
    }

    if (!deleted) {
      // Either the identifier doesn't exist or it doesn't belong to the
      // caller. Same 404 either way — surfacing the difference would be
      // an enumeration oracle.
      return c.json(
        { error: "not_found", message: "No such trusted browser.", requestId },
        404,
      );
    }

    log.info({ userId, identifier, requestId }, "Trusted device revoked");
    return c.json({ success: true }, 200);
  });
}
