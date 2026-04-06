/**
 * Admin workspace custom domain routes.
 *
 * Mounted under /api/v1/admin/domain. All routes require admin role + active org.
 * Enterprise plan (or self-hosted "free" tier) required to create a domain.
 * One custom domain per workspace (MVP).
 *
 * Wraps the existing EE domain module used by platform-domains.ts, scoping
 * operations to the caller's active organization. When the EE module is
 * unavailable (e.g. open-source builds), all routes return 404 with a
 * "not_available" error code.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext, RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, getWorkspaceDetails } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";
import {
  CustomDomainSchema,
  customDomainError,
  loadDomains,
} from "./shared-domains";

const log = createLogger("admin-domains");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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
    404: { description: "Enterprise features not available", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database or Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
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
    404: { description: "Enterprise features not available", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Domain already registered", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database or Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
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
    404: { description: "No custom domain configured or enterprise features not available", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database or Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const verifyDomainRoute = createRoute({
  method: "post",
  path: "/verify",
  tags: ["Admin — Custom Domain"],
  summary: "Check domain verification status",
  description: "Checks DNS propagation and TLS certificate status for the workspace's custom domain. Does not require enterprise plan — only adding a domain is plan-gated.",
  responses: {
    200: {
      description: "Verification result",
      content: { "application/json": { schema: CustomDomainSchema } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No custom domain configured or enterprise features not available", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database or Railway not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Plan gating helper
// ---------------------------------------------------------------------------

/**
 * Check whether the workspace is allowed to use custom domains.
 * Allowed tiers: "pro", "business" (SaaS) and "free" (self-hosted, which has no plan limits).
 * Also allows access when no internal DB is configured (self-hosted without managed billing).
 *
 * Fails closed: if the DB query fails, returns a 500 error rather than allowing access.
 * Returns null when allowed, or an error body when the plan gate fails.
 */
async function checkPlanGate(
  orgId: string,
  requestId: string,
): Promise<{ error: string; message: string; requestId: string; status: 403 | 500 } | null> {
  // Self-hosted without managed billing — no plan enforcement
  if (!hasInternalDB()) {
    return null;
  }

  let workspace: Awaited<ReturnType<typeof getWorkspaceDetails>>;
  try {
    workspace = await getWorkspaceDetails(orgId);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, requestId },
      "Plan gate check failed — database error",
    );
    return {
      error: "plan_check_failed",
      message: "Unable to verify workspace plan. Please try again.",
      requestId,
      status: 500,
    };
  }

  if (!workspace) {
    // Internal DB exists but org row not found — allow (may be pre-migration data)
    log.warn({ orgId, requestId }, "Plan gate: org row not found — allowing (pre-migration)");
    return null;
  }

  const tier = workspace.plan_tier;
  if (tier === "free" || tier === "pro" || tier === "business") {
    return null;
  }

  return {
    error: "plan_required",
    message: "Custom domains require a Pro or Business plan. Upgrade your workspace to enable this feature.",
    requestId,
    status: 403,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization.", requestId }, 400);
    }

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    const domains = yield* mod.listDomains(orgId);
    return c.json({ domain: domains[0] ?? null }, 200);
  }), { label: "get workspace domain", domainErrors: [customDomainError] });
});

// POST / — add custom domain (enterprise plan required)
adminDomains.openapi(addDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization.", requestId }, 400);
    }

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    // Enterprise plan gate
    const planError = yield* Effect.promise(() => checkPlanGate(orgId, requestId));
    if (planError) {
      return c.json({ error: planError.error, message: planError.message, requestId }, planError.status);
    }

    // MVP: one domain per workspace. TOCTOU note: concurrent requests could both pass
    // this check. A UNIQUE constraint on custom_domains(workspace_id) would be the
    // proper fix; the downstream registerDomain will fail with duplicate_domain if the
    // domain name itself collides.
    const existing = yield* mod.listDomains(orgId);
    if (existing.length > 0) {
      return c.json({
        error: "duplicate_domain",
        message: "This workspace already has a custom domain. Remove the existing domain before adding a new one.",
        requestId,
      }, 409);
    }

    const body = c.req.valid("json");

    const domain = yield* mod.registerDomain(orgId, body.domain);
    log.info({ orgId, domain: body.domain, requestId }, "Workspace custom domain registered");
    return c.json(domain, 201);
  }), { label: "add workspace domain", domainErrors: [customDomainError] });
});

// POST /verify — check domain verification status
adminDomains.openapi(verifyDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization.", requestId }, 400);
    }

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    // MVP: one domain per workspace, so we always operate on the first result
    const domains = yield* mod.listDomains(orgId);
    if (domains.length === 0) {
      return c.json({ error: "not_found", message: "No custom domain configured for this workspace.", requestId }, 404);
    }

    const domain = yield* mod.verifyDomain(domains[0].id);
    return c.json(domain, 200);
  }), { label: "verify workspace domain", domainErrors: [customDomainError] });
});

// DELETE / — remove workspace custom domain
adminDomains.openapi(removeDomainRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { requestId } = yield* RequestContext;

    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization.", requestId }, 400);
    }

    const mod = yield* Effect.promise(() => loadDomains());
    if (!mod) {
      return c.json({ error: "not_available", message: "Custom domains require enterprise features to be enabled.", requestId }, 404);
    }

    // MVP: one domain per workspace, so we always operate on the first result
    const domains = yield* mod.listDomains(orgId);
    if (domains.length === 0) {
      return c.json({ error: "not_found", message: "No custom domain configured for this workspace.", requestId }, 404);
    }

    yield* mod.deleteDomain(domains[0].id);
    log.info({ orgId, domainId: domains[0].id, requestId }, "Workspace custom domain removed");
    return c.json({ deleted: true }, 200);
  }), { label: "remove workspace domain", domainErrors: [customDomainError] });
});

export { adminDomains };
