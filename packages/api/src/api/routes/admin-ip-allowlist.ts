/**
 * Admin IP allowlist management routes.
 *
 * Mounted under /api/v1/admin/ip-allowlist. All routes require admin role AND
 * enterprise license (enforced within the IP allowlist service layer).
 *
 * EE imports are lazy (dynamic import) to avoid circular dependency issues
 * between @atlas/api and @atlas/ee at module link time.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { ErrorSchema, AuthErrorSchema, isValidId, createIdParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// Lazy-load EE module to break circular @atlas/api ↔ @atlas/ee dependency
async function loadEE() {
  return import("@atlas/ee/auth/ip-allowlist");
}

// Lazy-load the enterprise gate for the same reason. Mirrors the pattern in
// ee/src/auth/ip-allowlist.ts which dynamically imports `isEnterpriseEnabled`.
async function loadEnterpriseGate() {
  return import("@atlas/ee/index");
}

const log = createLogger("admin-ip-allowlist");

/** Map IPAllowlistError codes to HTTP responses. */
const IP_ALLOWLIST_STATUS_MAP: Record<string, number> = {
  validation: 400,
  conflict: 409,
  not_found: 404,
};

/**
 * Extract a clean message + optional code from the catch'd error. EE effects
 * that fail with `IPAllowlistError` surface `{ _tag: "IPAllowlistError",
 * code, message }` directly when composed via `yield*`; everything else is
 * a generic Error. Using FiberFailure unwrapping is *not* needed here — the
 * previous `Effect.runPromise(...)` + `Effect.tryPromise` nesting was what
 * flattened tagged errors into opaque Fiber wrappers.
 */
function describeIPAllowlistError(err: unknown): { message: string; code: string | null } {
  if (err instanceof Error) {
    const code = "code" in err && typeof (err as Record<string, unknown>).code === "string"
      ? ((err as Record<string, unknown>).code as string)
      : null;
    return { message: err.message, code };
  }
  return { message: String(err), code: null };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IPAllowlistEntrySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  cidr: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

const EntryIdParamSchema = createIdParamSchema("550e8400-e29b-41d4-a716-446655440000");

const CreateIPAllowlistBodySchema = z.object({
  cidr: z.string().min(1).openapi({
    example: "10.0.0.0/8",
    description: "CIDR notation (IPv4 or IPv6). Example: 10.0.0.0/8, 2001:db8::/32",
  }),
  description: z.string().optional().openapi({
    example: "Office network",
    description: "Human-readable description of the IP range",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listEntriesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — IP Allowlist"],
  summary: "List IP allowlist entries",
  description:
    "Returns all IP allowlist entries for the admin's active organization, plus the caller's current IP address.",
  responses: {
    200: {
      description: "List of IP allowlist entries",
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(IPAllowlistEntrySchema),
            total: z.number(),
            callerIP: z.string().nullable(),
            // True iff enterprise is enabled, the internal DB is configured,
            // AND at least one CIDR entry exists. The IP allowlist middleware
            // short-circuits to `{ allowed: true }` when either gate is off,
            // so admins need a way to tell "we have rules but they aren't
            // actually being enforced" apart from "rules are being enforced".
            effectivelyEnforced: z.boolean().openapi({
              example: true,
              description:
                "Whether the workspace's IP allowlist is actively gating requests. False when enterprise is disabled, internal DB is missing, or no entries exist.",
            }),
          }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const addEntryRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — IP Allowlist"],
  summary: "Add IP allowlist entry",
  description:
    "Adds a CIDR range to the workspace's IP allowlist. Supports both IPv4 and IPv6 notation.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateIPAllowlistBodySchema } },
    },
  },
  responses: {
    201: { description: "IP allowlist entry created", content: { "application/json": { schema: z.object({ entry: IPAllowlistEntrySchema }) } } },
    400: { description: "Invalid CIDR format or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "CIDR range already in allowlist", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — IP Allowlist"],
  summary: "Remove IP allowlist entry",
  description:
    "Removes an IP allowlist entry by ID. Changes take effect immediately.",
  request: { params: EntryIdParamSchema },
  responses: {
    200: { description: "IP allowlist entry removed", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    400: { description: "Invalid entry ID or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Entry not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminIPAllowlist = createAdminRouter();
adminIPAllowlist.use(requireOrgContext());

// GET / — list IP allowlist entries for the active org
adminIPAllowlist.openapi(listEntriesRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const callerIP = getClientIP(c.req.raw);

    const ee = yield* Effect.promise(loadEE);
    const enterpriseGate = yield* Effect.promise(loadEnterpriseGate);

    const entries = yield* Effect.tryPromise({
      try: () => Effect.runPromise(ee.listIPAllowlistEntries(orgId!)),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      const code = "code" in err ? (err as Record<string, unknown>).code : undefined;
      const status = (typeof code === "string" && IP_ALLOWLIST_STATUS_MAP[code]) || 500;
      return Effect.succeed(c.json(
        { error: "ip_allowlist_error", message: err.message },
        status as 400,
      ));
    }));

    // If catchAll produced an early response, return it
    if (entries instanceof Response) return entries;

    // Mirror the preconditions in ee/src/auth/ip-allowlist.ts#checkIPAllowlist
    // exactly: the middleware short-circuits to `{ allowed: true }` when EE is
    // disabled OR the internal DB is missing, regardless of row count. So
    // "enforcing" has to include both gates, not just entries.length > 0.
    const list = entries as unknown[];
    const effectivelyEnforced =
      enterpriseGate.isEnterpriseEnabled() && hasInternalDB() && list.length > 0;

    return c.json(
      { entries, total: list.length, callerIP, effectivelyEnforced },
      200,
    );
  }), { label: "list IP allowlist entries" });
});

// POST / — add a CIDR range to the allowlist
adminIPAllowlist.openapi(addEntryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    const body = c.req.valid("json");

    if (!body.cidr) {
      return c.json({ error: "bad_request", message: "Missing required field: cidr." }, 400);
    }

    const ee = yield* Effect.promise(loadEE);
    const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

    const entry = yield* ee.addIPAllowlistEntry(
      orgId!,
      body.cidr,
      body.description ?? null,
      user?.id ?? null,
    ).pipe(Effect.catchAll((err) => {
      // Emit audit on failure so an attacker using stolen creds leaves a
      // forensic record. targetId stays as the CIDR since no row id exists
      // yet; the real row id lives in metadata on the success path below.
      const { message, code } = describeIPAllowlistError(err);
      logAdminAction({
        actionType: ADMIN_ACTIONS.ip_allowlist.add,
        targetType: "ip_allowlist",
        targetId: "unknown",
        status: "failure",
        ipAddress,
        metadata: {
          cidr: body.cidr,
          description: body.description ?? null,
          error: message,
        },
      });
      const status = (code && IP_ALLOWLIST_STATUS_MAP[code]) || 500;
      return Effect.succeed(c.json(
        { error: "ip_allowlist_error", message },
        status as 400,
      ));
    }));

    if (entry instanceof Response) return entry;

    logAdminAction({
      actionType: ADMIN_ACTIONS.ip_allowlist.add,
      targetType: "ip_allowlist",
      targetId: entry.id,
      ipAddress,
      metadata: {
        id: entry.id,
        cidr: entry.cidr,
        description: entry.description,
      },
    });

    return c.json({ entry }, 201);
  }), { label: "add IP allowlist entry" });
});

// DELETE /:id — remove an IP allowlist entry
adminIPAllowlist.openapi(deleteEntryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { id: entryId } = c.req.valid("param");

    if (!isValidId(entryId)) {
      return c.json({ error: "bad_request", message: "Invalid entry ID." }, 400);
    }

    const ee = yield* Effect.promise(loadEE);
    const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;

    // Fetch the CIDR before deleting so the audit row records the actual
    // range that was removed, not just the opaque id. Listing is cheap
    // (bounded per org) and the EE API doesn't expose a by-id getter.
    // Pre-lookup failure is intentionally non-fatal: we'd rather audit
    // without the CIDR than 500 the delete and leave no forensic trace.
    // `priorListFailed` distinguishes "list failed" from "id didn't exist"
    // when reconstructing.
    const priorLookup = yield* ee.listIPAllowlistEntries(orgId!).pipe(
      Effect.map((entries) => ({
        cidr: entries.find((e) => e.id === entryId)?.cidr ?? null,
        failed: false,
      })),
      Effect.catchAll((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), orgId, entryId },
          "ip-allowlist pre-delete lookup failed; audit row will lack CIDR",
        );
        return Effect.succeed({ cidr: null, failed: true });
      }),
    );

    const deleted = yield* ee.removeIPAllowlistEntry(orgId!, entryId).pipe(
      Effect.catchAll((err) => {
        const { message, code } = describeIPAllowlistError(err);
        logAdminAction({
          actionType: ADMIN_ACTIONS.ip_allowlist.remove,
          targetType: "ip_allowlist",
          targetId: entryId,
          status: "failure",
          ipAddress,
          metadata: {
            id: entryId,
            ...(priorLookup.cidr !== null && { cidr: priorLookup.cidr }),
            ...(priorLookup.failed && { priorListFailed: true }),
            error: message,
          },
        });
        const status = (code && IP_ALLOWLIST_STATUS_MAP[code]) || 500;
        return Effect.succeed(c.json(
          { error: "ip_allowlist_error", message },
          status as 400,
        ));
      }),
    );

    if (deleted instanceof Response) return deleted;

    // Emit even when the id never existed — forensic reconstruction still
    // needs to see the attempt.
    logAdminAction({
      actionType: ADMIN_ACTIONS.ip_allowlist.remove,
      targetType: "ip_allowlist",
      targetId: entryId,
      ipAddress,
      metadata: {
        id: entryId,
        ...(priorLookup.cidr !== null && { cidr: priorLookup.cidr }),
        ...(priorLookup.failed && { priorListFailed: true }),
        found: Boolean(deleted),
      },
    });

    if (!deleted) {
      return c.json({ error: "not_found", message: "IP allowlist entry not found." }, 404);
    }
    return c.json({ message: "IP allowlist entry removed." }, 200);
  }), { label: "remove IP allowlist entry" });
});

export { adminIPAllowlist };
