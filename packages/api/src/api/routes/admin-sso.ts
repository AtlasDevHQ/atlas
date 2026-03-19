/**
 * Admin SSO provider management routes.
 *
 * Mounted under /api/v1/admin/sso. All routes require admin role AND
 * enterprise license (via `requireEnterprise("sso")`).
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { adminAuthPreamble } from "./admin-auth";
import {
  listSSOProviders,
  getSSOProvider,
  createSSOProvider,
  updateSSOProvider,
  deleteSSOProvider,
  redactProvider,
  summarizeProvider,
  SSOError,
} from "../../../../../ee/src/auth/sso";
import type {
  CreateSSOProviderRequest,
  UpdateSSOProviderRequest,
} from "@useatlas/types";

const log = createLogger("admin-sso");

const MAX_ID_LENGTH = 128;

function isValidId(id: string | undefined): id is string {
  return !!id && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

const SSO_ERROR_STATUS = { not_found: 404, conflict: 409, validation: 400 } as const;

/** Map SSO errors to HTTP responses. Returns null if not an SSO/enterprise error. */
function ssoErrorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 403 | 404 | 409 } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Enterprise features")) {
    return { body: { error: "enterprise_required", message }, status: 403 };
  }
  if (err instanceof SSOError) {
    return { body: { error: err.code, message: err.message }, status: SSO_ERROR_STATUS[err.code] };
  }
  return null;
}

const adminSso = new Hono();

// ---------------------------------------------------------------------------
// GET /providers — list SSO providers for the active org
// ---------------------------------------------------------------------------

adminSso.get("/providers", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      const providers = await listSSOProviders(orgId);
      return c.json({ providers: providers.map(summarizeProvider), total: providers.length });
    } catch (err) {
      const mapped = ssoErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to list SSO providers");
      return c.json({ error: "internal_error", message: "Failed to list SSO providers.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /providers/:id — get a single SSO provider
// ---------------------------------------------------------------------------

adminSso.get("/providers/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const providerId = c.req.param("id");

  if (!isValidId(providerId)) {
    return c.json({ error: "bad_request", message: "Invalid provider ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization." }, 400);
    }

    try {
      const provider = await getSSOProvider(orgId, providerId);
      if (!provider) {
        return c.json({ error: "not_found", message: "SSO provider not found." }, 404);
      }
      return c.json({ provider: redactProvider(provider) });
    } catch (err) {
      const mapped = ssoErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get SSO provider");
      return c.json({ error: "internal_error", message: "Failed to get SSO provider.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /providers — create a new SSO provider
// ---------------------------------------------------------------------------

adminSso.post("/providers", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization." }, 400);
    }

    let body: CreateSSOProviderRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }

    // Structural check only — business validation is in createSSOProvider
    if (!body.type || !body.issuer || !body.domain || !body.config) {
      return c.json({ error: "bad_request", message: "Missing required fields: type, issuer, domain, config." }, 400);
    }

    try {
      const provider = await createSSOProvider(orgId, body);
      return c.json({ provider: redactProvider(provider) }, 201);
    } catch (err) {
      const mapped = ssoErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to create SSO provider");
      return c.json({ error: "internal_error", message: "Failed to create SSO provider.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /providers/:id — update an SSO provider
// ---------------------------------------------------------------------------

adminSso.patch("/providers/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const providerId = c.req.param("id");

  if (!isValidId(providerId)) {
    return c.json({ error: "bad_request", message: "Invalid provider ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization." }, 400);
    }

    let body: UpdateSSOProviderRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }

    try {
      const provider = await updateSSOProvider(orgId, providerId, body);
      return c.json({ provider: redactProvider(provider) });
    } catch (err) {
      const mapped = ssoErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, providerId }, "Failed to update SSO provider");
      return c.json({ error: "internal_error", message: "Failed to update SSO provider.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /providers/:id — delete an SSO provider
// ---------------------------------------------------------------------------

adminSso.delete("/providers/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const providerId = c.req.param("id");

  if (!isValidId(providerId)) {
    return c.json({ error: "bad_request", message: "Invalid provider ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization." }, 400);
    }

    try {
      const deleted = await deleteSSOProvider(orgId, providerId);
      if (!deleted) {
        return c.json({ error: "not_found", message: "SSO provider not found." }, 404);
      }
      return c.json({ message: "SSO provider deleted." });
    } catch (err) {
      const mapped = ssoErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status);
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId, providerId }, "Failed to delete SSO provider");
      return c.json({ error: "internal_error", message: "Failed to delete SSO provider.", requestId }, 500);
    }
  });
});

export { adminSso };
