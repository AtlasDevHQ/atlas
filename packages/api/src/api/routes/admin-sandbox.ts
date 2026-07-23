/**
 * Admin sandbox routes.
 *
 * Mounted under /api/v1/admin/sandbox. All routes require admin role
 * and org context. Provides sandbox backend status, selection, and
 * BYOC credential management (connect/disconnect).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import {
  SANDBOX_PROVIDER_BACKEND_IDS,
  SandboxStatusSchema,
  normalizeSandboxBackendValue,
} from "@useatlas/schemas";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { createLogger } from "@atlas/api/lib/logger";
import { getSetting, deleteSetting } from "@atlas/api/lib/settings";
import {
  getExploreBackendType,
  getActiveSandboxPluginId,
  invalidateOrgExploreBackends,
} from "@atlas/api/lib/tools/explore";
import { useVercelSandbox, useSidecar } from "@atlas/api/lib/tools/backends/detect";
import {
  getSandboxCredentials,
  saveSandboxCredential,
  deleteSandboxCredential,
  SANDBOX_PROVIDERS,
} from "@atlas/api/lib/sandbox/credentials";
import { validateCredentials } from "@atlas/api/lib/sandbox/validate";
import {
  getProviderRuntimeAvailability,
  missingCredentialFields,
} from "@atlas/api/lib/sandbox/runtime";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-sandbox");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Status response wire shapes (SandboxStatusSchema and friends) live in
// `@useatlas/schemas` — single source of truth shared with the web admin
// page's `useAdminFetch` parse (#3371).

const ConnectRequestSchema = z.object({
  credentials: z.record(z.string(), z.unknown()),
});

const ConnectResponseSchema = z.object({
  connected: z.boolean(),
  displayName: z.string().nullable(),
  validatedAt: z.string(),
});

const DisconnectResponseSchema = z.object({
  disconnected: z.boolean(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getStatusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Admin — Sandbox"],
  summary: "Get sandbox backend status",
  description:
    "Returns the sandbox backend configuration for the current workspace, " +
    "including available backends, the active backend, any workspace override, " +
    "and connected BYOC providers.",
  responses: {
    200: {
      description: "Sandbox status",
      content: {
        "application/json": { schema: SandboxStatusSchema },
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
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const connectRoute = createRoute({
  method: "post",
  path: "/connect/{provider}",
  tags: ["Admin — Sandbox"],
  summary: "Connect a sandbox provider",
  description:
    "Validates credentials against the provider API and saves them for this org.",
  request: {
    params: createParamSchema("provider", "vercel"),
    body: {
      content: {
        "application/json": { schema: ConnectRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Provider connected",
      content: { "application/json": { schema: ConnectResponseSchema } },
    },
    400: {
      description: "Invalid provider",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    422: {
      description: "Credential validation failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: "/disconnect/{provider}",
  tags: ["Admin — Sandbox"],
  summary: "Disconnect a sandbox provider",
  description:
    "Removes stored credentials for a provider. If this was the active sandbox, " +
    "the workspace falls back to the platform default.",
  request: {
    params: createParamSchema("provider", "vercel"),
  },
  responses: {
    200: {
      description: "Provider disconnected",
      content: { "application/json": { schema: DisconnectResponseSchema } },
    },
    400: {
      description: "Invalid provider",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AvailableBackend {
  id: string;
  name: string;
  type: "built-in" | "plugin";
  available: boolean;
  description?: string;
}

async function getAvailableBackends(): Promise<AvailableBackend[]> {
  const backends: AvailableBackend[] = [];

  // Built-in backends
  backends.push({
    id: "vercel-sandbox",
    name: "Vercel Sandbox",
    type: "built-in",
    available: useVercelSandbox(),
    description: "Firecracker microVM with network isolation (Vercel)",
  });

  backends.push({
    id: "sidecar",
    name: "Sidecar",
    type: "built-in",
    available: useSidecar(),
    description: "HTTP-isolated container service",
  });

  // Plugin backends — discover from registry
  try {
    const { plugins } = await import("@atlas/api/lib/plugins/registry");
    const sandboxPlugins = plugins.getByType("sandbox");
    for (const plugin of sandboxPlugins) {
      backends.push({
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        type: "plugin",
        available: true,
        description: plugin.name ? `${plugin.name} sandbox plugin` : undefined,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ err: detail }, "Plugin registry unavailable — sandbox status will not include plugin backends");
  }

  return backends;
}

function isValidProvider(provider: string): provider is (typeof SANDBOX_PROVIDERS)[number] {
  return (SANDBOX_PROVIDERS as readonly string[]).includes(provider);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminSandbox = createAdminRouter();

// #4356 — every handler on this router reads `const { orgId } = c.get("orgContext")`
// directly: this mount is what makes that read non-null (a missing active org 400s
// here, before any handler runs). Stated once, at the mount, rather than repeated
// above each read. A structural test pins the pairing — see
// `__tests__/admin-router.test.ts` (#4751).
adminSandbox.use(requireOrgContext());
// F-53 — sandbox backend selection is a settings cluster surface.
adminSandbox.use(requirePermission("admin:settings"));

// GET /status — sandbox backend status for this workspace
adminSandbox.openapi(getStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = c.get("orgContext");

      // Workspace override — normalized once to backend-id vocabulary so
      // legacy stored provider keys ("e2b") resolve like backend ids
      // ("e2b-sandbox"), matching the explore runtime (#3375).
      const storedOverride = getSetting("ATLAS_SANDBOX_BACKEND", orgId) ?? null;
      const workspaceOverride = storedOverride
        ? normalizeSandboxBackendValue(storedOverride)
        : null;
      const workspaceSidecarUrl = getSetting("ATLAS_SANDBOX_URL", orgId) ?? null;

      // Platform default (the backend that would be used without any workspace override)
      const platformDefault = getExploreBackendType();
      const activePluginId = getActiveSandboxPluginId();
      const [allBackends, credentials, runtimeAvailability] = yield* Effect.promise(() =>
        Promise.all([
          getAvailableBackends(),
          getSandboxCredentials(orgId),
          getProviderRuntimeAvailability(),
        ]),
      );

      // A connected BYOC provider is *usable* when its stored credentials
      // carry every runtime-required field AND this deployment can construct
      // its backend. Manual mirror of the explore runtime's engagement gates
      // in `tryCreateByocBackend` (#3370) so `activeBackend`/`isActive`
      // report what actually runs — a gate added there must be added here.
      const usableByocBackendIds = new Set(
        credentials
          .filter(
            (cred) =>
              missingCredentialFields(cred.provider, cred.credentials).length === 0 &&
              runtimeAvailability[cred.provider],
          )
          .map((cred) => SANDBOX_PROVIDER_BACKEND_IDS[cred.provider]),
      );

      // Resolve the effective active backend
      let activeBackend: string;
      if (workspaceOverride) {
        // The override resolves when it's an available registered backend OR
        // a usable BYOC provider (BYOC backends are built on demand from
        // stored credentials and never appear in availableBackends).
        const found = allBackends.find((b) => b.id === workspaceOverride && b.available);
        activeBackend = found || usableByocBackendIds.has(workspaceOverride)
          ? workspaceOverride
          : platformDefault;
      } else {
        activeBackend = activePluginId ?? platformDefault;
      }

      // Build connected providers list. `isActive` requires BOTH the
      // (normalized) workspace override selecting this provider's backend id
      // AND the resolved `activeBackend` landing on it, so `isActive` can
      // never contradict `activeBackend` — previously this compared the
      // provider key against the stored override, which always mismatched
      // backend-id values (#3375). The override condition keeps a connected
      // vercel BYOC row from reading "Live" merely because the SaaS platform
      // default is `vercel-sandbox`.
      const connectedProviders = credentials.map((cred) => {
        const backendId = SANDBOX_PROVIDER_BACKEND_IDS[cred.provider];
        return {
          provider: cred.provider,
          displayName: cred.displayName,
          connectedAt: cred.connectedAt,
          validatedAt: cred.validatedAt,
          // Requires the usable-BYOC gate on top of the override/activeBackend
          // match: for vercel, `activeBackend` can resolve to "vercel-sandbox"
          // via the *operator's* built-in backend even when this row's stored
          // credentials can't run (needsReconnect) — without the gate the row
          // would read "Live" while explore actually executes on the
          // operator's account (#3370 review).
          isActive:
            workspaceOverride === backendId &&
            activeBackend === backendId &&
            usableByocBackendIds.has(backendId),
          needsReconnect:
            missingCredentialFields(cred.provider, cred.credentials).length > 0,
        };
      });

      return c.json(
        {
          activeBackend,
          platformDefault: activePluginId ?? platformDefault,
          workspaceOverride,
          workspaceSidecarUrl,
          availableBackends: allBackends,
          connectedProviders,
          providerRuntimeAvailability: runtimeAvailability,
        },
        200,
      );
    }),
    { label: "get sandbox status" },
  );
});

// POST /connect/{provider} — validate and save credentials
adminSandbox.openapi(connectRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = c.get("orgContext");
      const provider = c.req.param("provider");

      if (!isValidProvider(provider)) {
        return c.json(
          { error: "Bad Request", message: `Unknown provider: ${provider}. Valid providers: ${SANDBOX_PROVIDERS.join(", ")}` },
          400,
        );
      }

      // Parse body safely — c.req.json() throws on malformed JSON
      const body = yield* Effect.tryPromise({
        try: () => c.req.json<{ credentials?: Record<string, unknown> }>(),
        catch: (err) => new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`),
      }).pipe(Effect.catchAll((err) =>
        Effect.succeed({ _parseError: err.message } as const),
      ));

      if ("_parseError" in body) {
        return c.json(
          { error: "Bad Request", message: body._parseError },
          400,
        );
      }

      const credentials = body.credentials;
      if (!credentials || typeof credentials !== "object") {
        return c.json(
          { error: "Bad Request", message: "Request body must include a credentials object" },
          400,
        );
      }

      // Validate against the provider API
      const result = yield* Effect.promise(() => validateCredentials(provider, credentials));

      if (!result.valid) {
        return c.json(
          { error: "Validation Failed", message: result.error },
          422,
        );
      }

      // Save credentials
      yield* Effect.promise(() =>
        saveSandboxCredential(orgId, provider, credentials, result.displayName),
      );

      // Tear down this org's cached explore backends so the next explore
      // call rebuilds with the new credentials (#3370) — mirrors the
      // ConnectionRegistry's workspace pool drain on credential edits.
      // The Python tool needs no counterpart: its backends are per-request
      // (python.ts builds a fresh one each call, re-reading stored
      // credentials), so there is nothing cached to drain (#3410).
      invalidateOrgExploreBackends(orgId);

      log.info({ orgId, provider }, "Sandbox provider connected");

      return c.json(
        {
          connected: true,
          displayName: result.displayName ?? null,
          validatedAt: new Date().toISOString(),
        },
        200,
      );
    }),
    { label: "connect sandbox provider" },
  );
});

// DELETE /disconnect/{provider} — remove credentials
adminSandbox.openapi(disconnectRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = c.get("orgContext");
      const provider = c.req.param("provider");

      if (!isValidProvider(provider)) {
        return c.json(
          { error: "Bad Request", message: `Unknown provider: ${provider}. Valid providers: ${SANDBOX_PROVIDERS.join(", ")}` },
          400,
        );
      }

      const deleted = yield* Effect.promise(() =>
        deleteSandboxCredential(orgId, provider),
      );

      // Drop cached backends built from the deleted credentials so explore
      // can't keep running on them after disconnect (#3370).
      invalidateOrgExploreBackends(orgId);

      // If this was the active sandbox, reset to platform default. The
      // setting stores backend ids (legacy rows may hold provider keys),
      // so normalize before comparing against this provider's backend id.
      const workspaceOverride = getSetting("ATLAS_SANDBOX_BACKEND", orgId);
      const normalizedOverride = workspaceOverride
        ? normalizeSandboxBackendValue(workspaceOverride)
        : null;
      if (normalizedOverride === SANDBOX_PROVIDER_BACKEND_IDS[provider]) {
        yield* Effect.promise(() => deleteSetting("ATLAS_SANDBOX_BACKEND", undefined, orgId));
        log.info({ orgId, provider }, "Active sandbox provider disconnected — reset to platform default");
      }

      if (deleted) {
        log.info({ orgId, provider }, "Sandbox provider disconnected");
      }

      return c.json({ disconnected: deleted }, 200);
    }),
    { label: "disconnect sandbox provider" },
  );
});

export { adminSandbox };
