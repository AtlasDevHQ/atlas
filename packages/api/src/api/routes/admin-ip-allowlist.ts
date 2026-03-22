/**
 * Admin IP allowlist management routes.
 *
 * Mounted under /api/v1/admin/ip-allowlist. All routes require admin role AND
 * enterprise license (enforced within the IP allowlist service layer).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import { adminAuthPreamble } from "./admin-auth";
import {
  listIPAllowlistEntries,
  addIPAllowlistEntry,
  removeIPAllowlistEntry,
  IPAllowlistError,
} from "../../../../../ee/src/auth/ip-allowlist";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-ip-allowlist");

const MAX_ID_LENGTH = 128;

function isValidId(id: string | undefined): id is string {
  return !!id && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

const IP_ALLOWLIST_ERROR_STATUS = { validation: 400, conflict: 409, not_found: 404 } as const;

/** Map IP allowlist errors to HTTP responses. Returns null if not a known error. */
function ipAllowlistErrorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 403 | 404 | 409 } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Enterprise features")) {
    return { body: { error: "enterprise_required", message }, status: 403 };
  }
  if (err instanceof IPAllowlistError) {
    return { body: { error: err.code, message: err.message }, status: IP_ALLOWLIST_ERROR_STATUS[err.code] };
  }
  return null;
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

const EntryIdParamSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH).openapi({
    param: { name: "id", in: "path" },
    example: "550e8400-e29b-41d4-a716-446655440000",
  }),
});

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
          }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
      content: {
        "application/json": { schema: CreateIPAllowlistBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "IP allowlist entry created",
      content: {
        "application/json": {
          schema: z.object({ entry: IPAllowlistEntrySchema }),
        },
      },
    },
    400: {
      description: "Invalid CIDR format or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "CIDR range already in allowlist",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — IP Allowlist"],
  summary: "Remove IP allowlist entry",
  description:
    "Removes an IP allowlist entry by ID. Changes take effect immediately.",
  request: {
    params: EntryIdParamSchema,
  },
  responses: {
    200: {
      description: "IP allowlist entry removed",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: "Invalid entry ID or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Entry not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminIPAllowlist = new OpenAPIHono();

adminIPAllowlist.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
  }
  throw err;
});

// GET / — list IP allowlist entries for the active org
adminIPAllowlist.openapi(listEntriesRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
    }

    const callerIP = getClientIP(req);

    try {
      const entries = await listIPAllowlistEntries(orgId);
      return c.json({ entries, total: entries.length, callerIP }, 200);
    } catch (err) {
      const mapped = ipAllowlistErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to list IP allowlist entries");
      return c.json({ error: "internal_error", message: "Failed to list IP allowlist entries.", requestId }, 500);
    }
  }) as never;
});

// POST / — add a CIDR range to the allowlist
adminIPAllowlist.openapi(addEntryRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
    }

    const body = c.req.valid("json");

    if (!body.cidr) {
      return c.json({ error: "bad_request", message: "Missing required field: cidr." }, 400);
    }

    try {
      const entry = await addIPAllowlistEntry(
        orgId,
        body.cidr,
        body.description ?? null,
        authResult.user?.id ?? null,
      );
      return c.json({ entry }, 201);
    } catch (err) {
      const mapped = ipAllowlistErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to add IP allowlist entry");
      return c.json({ error: "internal_error", message: "Failed to add IP allowlist entry.", requestId }, 500);
    }
  }) as never;
});

// DELETE /:id — remove an IP allowlist entry
adminIPAllowlist.openapi(deleteEntryRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: entryId } = c.req.valid("param");

  if (!isValidId(entryId)) {
    return c.json({ error: "bad_request", message: "Invalid entry ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
    }

    try {
      const deleted = await removeIPAllowlistEntry(orgId, entryId);
      if (!deleted) {
        return c.json({ error: "not_found", message: "IP allowlist entry not found." }, 404);
      }
      return c.json({ message: "IP allowlist entry removed." }, 200);
    } catch (err) {
      const mapped = ipAllowlistErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, entryId }, "Failed to remove IP allowlist entry");
      return c.json({ error: "internal_error", message: "Failed to remove IP allowlist entry.", requestId }, 500);
    }
  }) as never;
});

export { adminIPAllowlist };
