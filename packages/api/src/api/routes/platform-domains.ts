/**
 * Platform custom domain routes — workspace-level custom domain management.
 *
 * Mounted at /api/v1/platform/domains. All routes require `platform_admin` role.
 *
 * Provides:
 * - GET    /                   — list all custom domains (platform admin view)
 * - POST   /                   — register a custom domain
 * - POST   /:id/verify         — trigger DNS verification via Railway
 * - DELETE /:id                — delete a custom domain
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { platformAdminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("platform-domains");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CustomDomainSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  domain: z.string(),
  status: z.enum(["pending", "verified", "failed"]),
  railwayDomainId: z.string().nullable(),
  cnameTarget: z.string().nullable(),
  certificateStatus: z.enum(["PENDING", "ISSUED", "FAILED"]).nullable(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
});

const RegisterDomainBodySchema = z.object({
  workspaceId: z.string().min(1).openapi({
    description: "Workspace ID to register the domain for",
    example: "org-abc123",
  }),
  domain: z.string().min(1).openapi({
    description: "Custom domain to register (e.g. 'data.customer.com')",
    example: "data.customer.com",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listDomainsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Platform Admin — Custom Domains"],
  summary: "List all custom domains",
  description: "Returns all registered custom domains across workspaces.",
  responses: {
    200: {
      description: "Domains list",
      content: {
        "application/json": {
          schema: z.object({ domains: z.array(CustomDomainSchema) }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const registerDomainRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Platform Admin — Custom Domains"],
  summary: "Register a custom domain",
  description: "Register a custom domain for a workspace via Railway. Returns CNAME target for DNS setup.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RegisterDomainBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Domain registered",
      content: { "application/json": { schema: CustomDomainSchema } },
    },
    400: { description: "Invalid domain", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Enterprise feature not enabled", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Domain already registered", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const verifyDomainRoute = createRoute({
  method: "post",
  path: "/:id/verify",
  tags: ["Platform Admin — Custom Domains"],
  summary: "Verify a custom domain",
  description: "Checks DNS propagation and TLS certificate status via Railway.",
  responses: {
    200: {
      description: "Verification result",
      content: { "application/json": { schema: CustomDomainSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Domain not found or enterprise not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteDomainRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["Platform Admin — Custom Domains"],
  summary: "Delete a custom domain",
  description: "Removes a custom domain from both Railway and Atlas.",
  responses: {
    200: {
      description: "Domain deleted",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Domain not found or enterprise not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Module loader (lazy import — fail gracefully when ee is unavailable)
// ---------------------------------------------------------------------------

type DomainsModule = typeof import("@atlas/ee/platform/domains");

const DOMAIN_ERROR_STATUS: Record<string, number> = {
  no_internal_db: 404,
  invalid_domain: 400,
  duplicate_domain: 409,
  domain_not_found: 404,
  railway_error: 502,
  railway_not_configured: 503,
};

async function loadDomains(): Promise<DomainsModule | null> {
  try {
    return await import("@atlas/ee/platform/domains");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      return null;
    }
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load domains module — unexpected error",
    );
    throw err;
  }
}

function handleDomainError(err: unknown, requestId: string): { error: string; message: string; status: number; requestId: string } {
  const message = err instanceof Error ? err.message : String(err);

  // Typed domain errors (most specific — check first)
  if (err instanceof Error && err.name === "DomainError" && "code" in err) {
    const code = (err as { code: string }).code;
    const status = DOMAIN_ERROR_STATUS[code] ?? 500;
    // Sanitize Railway errors to avoid leaking infrastructure details
    const safeMessage = (code === "railway_error" || code === "railway_not_configured")
      ? `Railway API error (ref: ${requestId.slice(0, 8)})`
      : message;
    return { error: code, message: safeMessage, status, requestId };
  }

  // Enterprise license error → 403 (requireEnterprise throws plain Error)
  if (err instanceof Error && message.includes("Enterprise features")) {
    return { error: "enterprise_required", message, status: 403, requestId };
  }

  return { error: "internal_error", message: `Unexpected error (ref: ${requestId.slice(0, 8)})`, status: 500, requestId };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformDomains = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

platformDomains.use(platformAdminAuth);
platformDomains.use(requestContext);

// ── List all domains ─────────────────────────────────────────────────

platformDomains.openapi(listDomainsRoute, async (c) => {
  const requestId = c.get("requestId");

  const mod = await loadDomains();
  if (!mod) {
    return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
  }

  try {
    const domains = await mod.listAllDomains();
    return c.json({ domains }, 200);
  } catch (err) {
    const result = handleDomainError(err, requestId);
    const logFn = result.status >= 500 ? log.error : log.warn;
    logFn({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list domains");
    return c.json({ error: result.error, message: result.message, requestId: result.requestId }, result.status as 403);
  }
});

// ── Register domain ──────────────────────────────────────────────────

platformDomains.openapi(registerDomainRoute, async (c) => {
  const requestId = c.get("requestId");
  const body = c.req.valid("json");

  const mod = await loadDomains();
  if (!mod) {
    return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
  }

  try {
    const domain = await mod.registerDomain(body.workspaceId, body.domain);
    log.info({ workspaceId: body.workspaceId, domain: body.domain, requestId }, "Custom domain registered");
    return c.json(domain, 201);
  } catch (err) {
    const result = handleDomainError(err, requestId);
    const logFn = result.status >= 500 ? log.error : log.warn;
    logFn({ err: err instanceof Error ? err : new Error(String(err)), domain: body.domain, requestId }, "Failed to register domain");
    return c.json({ error: result.error, message: result.message, requestId: result.requestId }, result.status as 400);
  }
});

// ── Verify domain ────────────────────────────────────────────────────

platformDomains.openapi(verifyDomainRoute, async (c) => {
  const requestId = c.get("requestId");
  const domainId = c.req.param("id");

  const mod = await loadDomains();
  if (!mod) {
    return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
  }

  try {
    const domain = await mod.verifyDomain(domainId);
    return c.json(domain, 200);
  } catch (err) {
    const result = handleDomainError(err, requestId);
    const logFn = result.status >= 500 ? log.error : log.warn;
    logFn({ err: err instanceof Error ? err : new Error(String(err)), domainId, requestId }, "Failed to verify domain");
    return c.json({ error: result.error, message: result.message, requestId: result.requestId }, result.status as 404);
  }
});

// ── Delete domain ────────────────────────────────────────────────────

platformDomains.openapi(deleteDomainRoute, async (c) => {
  const requestId = c.get("requestId");
  const domainId = c.req.param("id");

  const mod = await loadDomains();
  if (!mod) {
    return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
  }

  try {
    await mod.deleteDomain(domainId);
    log.info({ domainId, requestId }, "Custom domain deleted");
    return c.json({ deleted: true }, 200);
  } catch (err) {
    const result = handleDomainError(err, requestId);
    const logFn = result.status >= 500 ? log.error : log.warn;
    logFn({ err: err instanceof Error ? err : new Error(String(err)), domainId, requestId }, "Failed to delete domain");
    return c.json({ error: result.error, message: result.message, requestId: result.requestId }, result.status as 404);
  }
});

export { platformDomains };
