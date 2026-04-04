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
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";
import {
  CustomDomainSchema,
  customDomainError,
  loadDomains,
} from "./shared-domains";

const log = createLogger("platform-domains");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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
// Router
// ---------------------------------------------------------------------------

const platformDomains = createPlatformRouter();

// ── List all domains ─────────────────────────────────────────────────

platformDomains.openapi(listDomainsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    const domains = yield* mod.listAllDomains();
    return c.json({ domains }, 200);
  }), { label: "list domains", domainErrors: [customDomainError] });
});

// ── Register domain ──────────────────────────────────────────────────

platformDomains.openapi(registerDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const body = c.req.valid("json");

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    const domain = yield* mod.registerDomain(body.workspaceId, body.domain);
    log.info({ workspaceId: body.workspaceId, domain: body.domain, requestId }, "Custom domain registered");
    return c.json(domain, 201);
  }), { label: "register domain", domainErrors: [customDomainError] });
});

// ── Verify domain ────────────────────────────────────────────────────

platformDomains.openapi(verifyDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const domainId = c.req.param("id");

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    const domain = yield* mod.verifyDomain(domainId);
    return c.json(domain, 200);
  }), { label: "verify domain", domainErrors: [customDomainError] });
});

// ── Delete domain ────────────────────────────────────────────────────

platformDomains.openapi(deleteDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const domainId = c.req.param("id");

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    yield* mod.deleteDomain(domainId);
    log.info({ domainId, requestId }, "Custom domain deleted");
    return c.json({ deleted: true }, 200);
  }), { label: "delete domain", domainErrors: [customDomainError] });
});

export { platformDomains };
