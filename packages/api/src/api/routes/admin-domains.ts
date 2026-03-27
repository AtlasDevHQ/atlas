/**
 * Admin workspace custom domain routes.
 *
 * Mounted under /api/v1/admin/domain. All routes require admin role + active org.
 * Enterprise plan (or self-hosted "free" tier) required to create a domain.
 * One custom domain per workspace (MVP).
 *
 * Wraps the existing EE domain module used by platform-domains.ts, scoping
 * operations to the caller's active organization.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect, type DomainErrorMapping } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { getWorkspaceDetails } from "@atlas/api/lib/db/internal";
import { DomainError, type DomainErrorCode } from "@atlas/ee/platform/domains";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-domains");

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

const AddDomainBodySchema = z.object({
  domain: z.string().min(1).openapi({
    description: "Custom domain to register (e.g. 'data.acme.com')",
    example: "data.acme.com",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getDomainRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Custom Domain"],
  summary: "Get workspace custom domain",
  description: "Returns the custom domain for the current workspace, or null if none is configured.",
  responses: {
    200: {
      description: "Workspace domain (null if none)",
      content: {
        "application/json": {
          schema: z.object({ domain: CustomDomainSchema.nullable() }),
        },
      },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const addDomainRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Custom Domain"],
  summary: "Add a custom domain",
  description: "Register a custom domain for the current workspace. Enterprise plan required (self-hosted is always allowed). One domain per workspace.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AddDomainBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Domain registered",
      content: { "application/json": { schema: CustomDomainSchema } },
    },
    400: { description: "Invalid domain or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Enterprise plan required", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Domain already registered", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const removeDomainRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Admin — Custom Domain"],
  summary: "Remove workspace custom domain",
  description: "Removes the custom domain from both Railway and Atlas for the current workspace.",
  responses: {
    200: {
      description: "Domain removed",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No custom domain configured or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const verifyDomainRoute = createRoute({
  method: "post",
  path: "/verify",
  tags: ["Admin — Custom Domain"],
  summary: "Check domain verification status",
  description: "Checks DNS propagation and TLS certificate status for the workspace's custom domain.",
  responses: {
    200: {
      description: "Verification result",
      content: { "application/json": { schema: CustomDomainSchema } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No custom domain configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
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

function sanitizeDomainError(err: unknown, requestId: string): void {
  if (err instanceof DomainError && SANITIZED_CODES.has(err.code)) {
    log.error({ err, code: err.code, requestId }, "Infrastructure domain error");
    err.message = `Domain service error (ref: ${requestId.slice(0, 8)})`;
  }
}

// ---------------------------------------------------------------------------
// Plan gating helper
// ---------------------------------------------------------------------------

/**
 * Check whether the workspace is allowed to use custom domains.
 * Allowed tiers: "enterprise" (SaaS) and "free" (self-hosted, which has no plan limits).
 */
async function requireEnterprisePlan(
  orgId: string,
  requestId: string,
): Promise<{ allowed: true } | { allowed: false; status: 403; body: { error: string; message: string; requestId: string } }> {
  const workspace = await getWorkspaceDetails(orgId);
  if (!workspace) {
    // No workspace row — self-hosted without managed billing, allow
    return { allowed: true };
  }

  const tier = workspace.plan_tier;
  if (tier === "enterprise" || tier === "free") {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: 403,
    body: {
      error: "plan_required",
      message: "Custom domains require an Enterprise plan. Upgrade your workspace to enable this feature.",
      requestId,
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminDomains = createAdminRouter();

adminDomains.use(requireOrgContext());

// GET / — get workspace custom domain
adminDomains.openapi(getDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    const domains = yield* Effect.promise(() => mod.listDomains(orgId!));
    return c.json({ domain: domains[0] ?? null }, 200);
  }), { label: "get workspace domain", domainErrors: domainDomainErrors });
});

// POST / — add custom domain (enterprise plan required)
adminDomains.openapi(addDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    // Enterprise plan gate
    const planCheck = yield* Effect.promise(() => requireEnterprisePlan(orgId!, requestId));
    if (!planCheck.allowed) {
      return c.json(planCheck.body, planCheck.status);
    }

    // One domain per workspace — check if one already exists
    const existing = yield* Effect.promise(() => mod.listDomains(orgId!));
    if (existing.length > 0) {
      return c.json({
        error: "duplicate_domain",
        message: "This workspace already has a custom domain. Remove the existing domain before adding a new one.",
        requestId,
      }, 409);
    }

    const body = c.req.valid("json");

    return yield* Effect.tryPromise({
      try: async () => {
        const domain = await mod.registerDomain(orgId!, body.domain);
        log.info({ orgId, domain: body.domain, requestId }, "Workspace custom domain registered");
        return c.json(domain, 201);
      },
      catch: (err) => {
        sanitizeDomainError(err, requestId);
        return err instanceof Error ? err : new Error(String(err));
      },
    });
  }), { label: "add workspace domain", domainErrors: domainDomainErrors });
});

// POST /verify — check domain verification status
adminDomains.openapi(verifyDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    // Find the workspace's domain
    const domains = yield* Effect.promise(() => mod.listDomains(orgId!));
    if (domains.length === 0) {
      return c.json({ error: "not_found", message: "No custom domain configured for this workspace.", requestId }, 404);
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const domain = await mod.verifyDomain(domains[0].id);
        return c.json(domain, 200);
      },
      catch: (err) => {
        sanitizeDomainError(err, requestId);
        return err instanceof Error ? err : new Error(String(err));
      },
    });
  }), { label: "verify workspace domain", domainErrors: domainDomainErrors });
});

// DELETE / — remove workspace custom domain
adminDomains.openapi(removeDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    // Find the workspace's domain
    const domains = yield* Effect.promise(() => mod.listDomains(orgId!));
    if (domains.length === 0) {
      return c.json({ error: "not_found", message: "No custom domain configured for this workspace.", requestId }, 404);
    }

    return yield* Effect.tryPromise({
      try: async () => {
        await mod.deleteDomain(domains[0].id);
        log.info({ orgId, domainId: domains[0].id, requestId }, "Workspace custom domain removed");
        return c.json({ deleted: true }, 200);
      },
      catch: (err) => {
        sanitizeDomainError(err, requestId);
        return err instanceof Error ? err : new Error(String(err));
      },
    });
  }), { label: "remove workspace domain", domainErrors: domainDomainErrors });
});

export { adminDomains };
