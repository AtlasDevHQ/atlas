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

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runHandler, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { DomainError, type DomainErrorCode } from "@atlas/ee/platform/domains";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

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
  description: "SaaS only. Returns all registered custom domains across workspaces.",
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
    503: { description: "Required infrastructure not configured (database or Railway)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const registerDomainRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Platform Admin — Custom Domains"],
  summary: "Register a custom domain",
  description: "SaaS only. Register a custom domain for a workspace via Railway. Returns CNAME target for DNS setup.",
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
    503: { description: "Required infrastructure not configured (database or Railway)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const verifyDomainRoute = createRoute({
  method: "post",
  path: "/:id/verify",
  tags: ["Platform Admin — Custom Domains"],
  summary: "Verify a custom domain",
  description: "SaaS only. Checks DNS propagation and TLS certificate status via Railway.",
  responses: {
    200: {
      description: "Verification result",
      content: { "application/json": { schema: CustomDomainSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Domain not found or enterprise not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Required infrastructure not configured (database or Railway)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteDomainRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["Platform Admin — Custom Domains"],
  summary: "Delete a custom domain",
  description: "SaaS only. Removes a custom domain from both Railway and Atlas.",
  responses: {
    200: {
      description: "Domain deleted",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Domain not found or enterprise not enabled", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Required infrastructure not configured (database or Railway)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Module loader (lazy import — fail gracefully when ee is unavailable)
// ---------------------------------------------------------------------------

type DomainsModule = typeof import("@atlas/ee/platform/domains");

/** Infrastructure error codes whose messages may contain internal details. */
const SANITIZED_CODES = new Set<DomainErrorCode>(["railway_error", "railway_not_configured", "data_integrity"]);

const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, ContentfulStatusCode> = {
  no_internal_db: 503,
  invalid_domain: 400,
  duplicate_domain: 409,
  domain_not_found: 404,
  railway_error: 502,
  railway_not_configured: 503,
  data_integrity: 500,
};

const domainDomainErrors: DomainErrorMapping[] = [
  [DomainError, DOMAIN_ERROR_STATUS],
];

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

/**
 * Sanitize DomainError messages for infrastructure errors before they
 * reach the client. Railway errors and data integrity errors may contain
 * internal infrastructure details that should not be exposed.
 *
 * User-facing errors (invalid_domain, duplicate_domain, domain_not_found)
 * pass through unmodified.
 */
function sanitizeDomainError(err: unknown, requestId: string): void {
  if (err instanceof DomainError && SANITIZED_CODES.has(err.code)) {
    // Log the real error for debugging, then replace the message
    log.error({ err, code: err.code, requestId }, "Infrastructure domain error");
    err.message = `Domain service error (ref: ${requestId.slice(0, 8)})`;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformDomains = createPlatformRouter();

// ── List all domains ─────────────────────────────────────────────────

platformDomains.openapi(listDomainsRoute, async (c) => runHandler(c, "list domains", async () => {
  const requestId = c.get("requestId");

  const mod = await loadDomains();
  if (!mod) {
    return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
  }

  const domains = await mod.listAllDomains();
  return c.json({ domains }, 200);
}, { domainErrors: domainDomainErrors }));

// ── Register domain ──────────────────────────────────────────────────

platformDomains.openapi(registerDomainRoute, async (c) => runHandler(c, "register domain", async () => {
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
    sanitizeDomainError(err, requestId);
    throw err;
  }
}, { domainErrors: domainDomainErrors }));

// ── Verify domain ────────────────────────────────────────────────────

platformDomains.openapi(verifyDomainRoute, async (c) => runHandler(c, "verify domain", async () => {
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
    sanitizeDomainError(err, requestId);
    throw err;
  }
}, { domainErrors: domainDomainErrors }));

// ── Delete domain ────────────────────────────────────────────────────

platformDomains.openapi(deleteDomainRoute, async (c) => runHandler(c, "delete domain", async () => {
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
    sanitizeDomainError(err, requestId);
    throw err;
  }
}, { domainErrors: domainDomainErrors }));

export { platformDomains };
