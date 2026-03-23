/**
 * Admin IP allowlist management routes.
 *
 * Mounted under /api/v1/admin/ip-allowlist. All routes require admin role AND
 * enterprise license (enforced within the IP allowlist service layer).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import {
  listIPAllowlistEntries,
  addIPAllowlistEntry,
  removeIPAllowlistEntry,
  IPAllowlistError,
} from "@atlas/ee/auth/ip-allowlist";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("admin-ip-allowlist");

const MAX_ID_LENGTH = 128;

function isValidId(id: string | undefined): id is string {
  return !!id && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

const IP_ALLOWLIST_ERROR_STATUS = { validation: 400, conflict: 409, not_found: 404 } as const;

/**
 * Throw HTTPException for known IP allowlist errors. Enterprise license
 * errors → 403; IPAllowlistError → 400/404/409. Unknown errors fall through.
 */
function throwIfIPAllowlistError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Enterprise features")) {
    throw new HTTPException(403, {
      res: Response.json({ error: "enterprise_required", message }, { status: 403 }),
    });
  }
  if (err instanceof IPAllowlistError) {
    const status = IP_ALLOWLIST_ERROR_STATUS[err.code];
    throw new HTTPException(status, {
      res: Response.json({ error: err.code, message: err.message }, { status }),
    });
  }
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

const adminIPAllowlist = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

adminIPAllowlist.use(adminAuth);
adminIPAllowlist.use(requestContext);

adminIPAllowlist.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Our thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// GET / — list IP allowlist entries for the active org
adminIPAllowlist.openapi(listEntriesRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  const callerIP = getClientIP(c.req.raw);

  try {
    const entries = await listIPAllowlistEntries(orgId);
    return c.json({ entries, total: entries.length, callerIP }, 200);
  } catch (err) {
    throwIfIPAllowlistError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to list IP allowlist entries");
    return c.json({ error: "internal_error", message: "Failed to list IP allowlist entries.", requestId }, 500);
  }
});

// POST / — add a CIDR range to the allowlist
adminIPAllowlist.openapi(addEntryRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

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
    throwIfIPAllowlistError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to add IP allowlist entry");
    return c.json({ error: "internal_error", message: "Failed to add IP allowlist entry.", requestId }, 500);
  }
});

// DELETE /:id — remove an IP allowlist entry
adminIPAllowlist.openapi(deleteEntryRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");
  const { id: entryId } = c.req.valid("param");

  if (!isValidId(entryId)) {
    return c.json({ error: "bad_request", message: "Invalid entry ID." }, 400);
  }

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
    throwIfIPAllowlistError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, entryId }, "Failed to remove IP allowlist entry");
    return c.json({ error: "internal_error", message: "Failed to remove IP allowlist entry.", requestId }, 500);
  }
});

export { adminIPAllowlist };
