/**
 * Admin SSO provider management routes.
 *
 * Mounted under /api/v1/admin/sso. All routes require admin role AND
 * enterprise license (enforced within the SSO service layer).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { withErrorHandler } from "@atlas/api/lib/routes/error-handler";
import {
  listSSOProviders,
  getSSOProvider,
  createSSOProvider,
  updateSSOProvider,
  deleteSSOProvider,
  redactProvider,
  summarizeProvider,
  setSSOEnforcement,
  isSSOEnforced,
  SSOError,
  SSOEnforcementError,
} from "@atlas/ee/auth/sso";
import type {
  CreateSSOProviderRequest,
  UpdateSSOProviderRequest,
} from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema, isValidId, createIdParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const SSO_ERROR_STATUS = { not_found: 404, conflict: 409, validation: 400 } as const;
const SSO_ENFORCEMENT_ERROR_STATUS = { no_provider: 400, not_enterprise: 400 } as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


const SSOProviderSummarySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["saml", "oidc"]),
  issuer: z.string(),
  domain: z.string(),
  enabled: z.boolean(),
  ssoEnforced: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

const SSOProviderDetailSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["saml", "oidc"]),
  issuer: z.string(),
  domain: z.string(),
  enabled: z.boolean(),
  ssoEnforced: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  config: z.record(z.string(), z.unknown()),
}).passthrough();

const ProviderIdParamSchema = createIdParamSchema("prov_abc123");

const CreateSSOProviderBodySchema = z.object({
  type: z.enum(["saml", "oidc"]),
  issuer: z.string(),
  domain: z.string(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()),
});

const UpdateSSOProviderBodySchema = z.object({
  issuer: z.string().optional(),
  domain: z.string().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const SSOEnforcementBodySchema = z.object({
  enforced: z.boolean(),
});

const SSOEnforcementResponseSchema = z.object({
  enforced: z.boolean(),
  orgId: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listProvidersRoute = createRoute({
  method: "get",
  path: "/providers",
  tags: ["Admin — SSO"],
  summary: "List SSO providers",
  description:
    "Returns all SSO providers configured for the admin's active organization. Each provider is returned as a summary (without full config).",
  responses: {
    200: {
      description: "List of SSO providers",
      content: {
        "application/json": {
          schema: z.object({
            providers: z.array(SSOProviderSummarySchema),
            total: z.number(),
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

const getProviderRoute = createRoute({
  method: "get",
  path: "/providers/{id}",
  tags: ["Admin — SSO"],
  summary: "Get SSO provider",
  description:
    "Returns a single SSO provider by ID, including the full (redacted) configuration.",
  request: {
    params: ProviderIdParamSchema,
  },
  responses: {
    200: {
      description: "SSO provider details",
      content: {
        "application/json": {
          schema: z.object({ provider: SSOProviderDetailSchema }),
        },
      },
    },
    400: {
      description: "Invalid provider ID or no active organization",
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
      description: "SSO provider not found or internal database not configured",
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

const createProviderRoute = createRoute({
  method: "post",
  path: "/providers",
  tags: ["Admin — SSO"],
  summary: "Create SSO provider",
  description:
    "Creates a new SSO provider for the admin's active organization. Requires type, issuer, domain, and config.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: CreateSSOProviderBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "SSO provider created",
      content: {
        "application/json": {
          schema: z.object({ provider: SSOProviderDetailSchema }),
        },
      },
    },
    400: {
      description: "Invalid request body or no active organization",
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
      description: "SSO provider conflict (duplicate domain)",
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

const updateProviderRoute = createRoute({
  method: "patch",
  path: "/providers/{id}",
  tags: ["Admin — SSO"],
  summary: "Update SSO provider",
  description:
    "Updates an existing SSO provider. All fields are optional — only provided fields are updated.",
  request: {
    params: ProviderIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: UpdateSSOProviderBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "SSO provider updated",
      content: {
        "application/json": {
          schema: z.object({ provider: SSOProviderDetailSchema }),
        },
      },
    },
    400: {
      description: "Invalid provider ID, request body, or no active organization",
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
      description: "SSO provider not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "SSO provider conflict (duplicate domain)",
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

const deleteProviderRoute = createRoute({
  method: "delete",
  path: "/providers/{id}",
  tags: ["Admin — SSO"],
  summary: "Delete SSO provider",
  description:
    "Permanently removes an SSO provider by ID.",
  request: {
    params: ProviderIdParamSchema,
  },
  responses: {
    200: {
      description: "SSO provider deleted",
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: "Invalid provider ID or no active organization",
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
      description: "SSO provider not found or internal database not configured",
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

const getEnforcementRoute = createRoute({
  method: "get",
  path: "/enforcement",
  tags: ["Admin — SSO"],
  summary: "Get SSO enforcement status",
  description:
    "Returns whether SSO enforcement is enabled for the admin's active organization.",
  responses: {
    200: {
      description: "SSO enforcement status",
      content: {
        "application/json": { schema: SSOEnforcementResponseSchema },
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

const setEnforcementRoute = createRoute({
  method: "put",
  path: "/enforcement",
  tags: ["Admin — SSO"],
  summary: "Set SSO enforcement",
  description:
    "Enable or disable SSO enforcement for the admin's active organization. When enabled, " +
    "password login is blocked for all members — they must sign in via the configured identity provider. " +
    "Requires at least one active SSO provider to enable enforcement.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: SSOEnforcementBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "SSO enforcement updated",
      content: {
        "application/json": { schema: SSOEnforcementResponseSchema },
      },
    },
    400: {
      description: "Invalid request body, no active organization, or no active SSO provider",
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminSso = createAdminRouter();
adminSso.use(requireOrgContext());

// GET /providers — list SSO providers for the active org
adminSso.openapi(listProvidersRoute, withErrorHandler("list SSO providers", async (c) => {
  const { orgId } = c.get("orgContext");

  const providers = await listSSOProviders(orgId);
  return c.json({ providers: providers.map(summarizeProvider), total: providers.length }, 200);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

// GET /providers/:id — get a single SSO provider
adminSso.openapi(getProviderRoute, withErrorHandler("get SSO provider", async (c) => {
  const { orgId } = c.get("orgContext");
  const { id: providerId } = c.req.valid("param");

  if (!isValidId(providerId)) {
    return c.json({ error: "bad_request", message: "Invalid provider ID." }, 400);
  }

  const provider = await getSSOProvider(orgId, providerId);
  if (!provider) {
    return c.json({ error: "not_found", message: "SSO provider not found." }, 404);
  }
  return c.json({ provider: redactProvider(provider) }, 200);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

// POST /providers — create a new SSO provider
adminSso.openapi(createProviderRoute, withErrorHandler("create SSO provider", async (c) => {
  const { orgId } = c.get("orgContext");
  const body = c.req.valid("json");

  // Structural check only — business validation is in createSSOProvider
  if (!body.type || !body.issuer || !body.domain || !body.config) {
    return c.json({ error: "bad_request", message: "Missing required fields: type, issuer, domain, config." }, 400);
  }

  const provider = await createSSOProvider(orgId, body as unknown as CreateSSOProviderRequest);
  return c.json({ provider: redactProvider(provider) }, 201);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

// PATCH /providers/:id — update an SSO provider
adminSso.openapi(updateProviderRoute, withErrorHandler("update SSO provider", async (c) => {
  const { orgId } = c.get("orgContext");
  const { id: providerId } = c.req.valid("param");

  if (!isValidId(providerId)) {
    return c.json({ error: "bad_request", message: "Invalid provider ID." }, 400);
  }

  const body = c.req.valid("json") as UpdateSSOProviderRequest;

  const provider = await updateSSOProvider(orgId, providerId, body);
  return c.json({ provider: redactProvider(provider) }, 200);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

// DELETE /providers/:id — delete an SSO provider
adminSso.openapi(deleteProviderRoute, withErrorHandler("delete SSO provider", async (c) => {
  const { orgId } = c.get("orgContext");
  const { id: providerId } = c.req.valid("param");

  if (!isValidId(providerId)) {
    return c.json({ error: "bad_request", message: "Invalid provider ID." }, 400);
  }

  const deleted = await deleteSSOProvider(orgId, providerId);
  if (!deleted) {
    return c.json({ error: "not_found", message: "SSO provider not found." }, 404);
  }
  return c.json({ message: "SSO provider deleted." }, 200);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

// GET /enforcement — get SSO enforcement status
adminSso.openapi(getEnforcementRoute, withErrorHandler("get SSO enforcement status", async (c) => {
  const { orgId } = c.get("orgContext");

  const result = await isSSOEnforced(orgId);
  return c.json({ enforced: result?.enforced ?? false, orgId }, 200);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

// PUT /enforcement — set SSO enforcement
adminSso.openapi(setEnforcementRoute, withErrorHandler("set SSO enforcement", async (c) => {
  const { orgId } = c.get("orgContext");
  const { enforced } = c.req.valid("json");

  const result = await setSSOEnforcement(orgId, enforced);
  return c.json(result, 200);
}, [SSOEnforcementError, SSO_ENFORCEMENT_ERROR_STATUS], [SSOError, SSO_ERROR_STATUS]));

export { adminSso };
