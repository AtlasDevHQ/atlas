/**
 * Admin sandbox routes.
 *
 * Mounted under /api/v1/admin/sandbox. All routes require admin role
 * and org context. Provides sandbox backend status, selection, and
 * BYOC credential management (connect/disconnect).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { getSetting, deleteSetting } from "@atlas/api/lib/settings";
import {
  getExploreBackendType,
  getActiveSandboxPluginId,
} from "@atlas/api/lib/tools/explore";
import { useVercelSandbox, useSidecar } from "@atlas/api/lib/tools/backends/detect";
import {
  getSandboxCredentials,
  saveSandboxCredential,
  deleteSandboxCredential,
  SANDBOX_PROVIDERS,
} from "@atlas/api/lib/sandbox/credentials";
import { validateCredentials } from "@atlas/api/lib/sandbox/validate";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-sandbox");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SandboxBackendSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["built-in", "plugin"]),
  available: z.boolean(),
  description: z.string().optional(),
});

const ConnectedProviderSchema = z.object({
  provider: z.enum(SANDBOX_PROVIDERS),
  displayName: z.string().nullable(),
  connectedAt: z.string(),
  validatedAt: z.string().nullable(),
  isActive: z.boolean(),
});

const SandboxStatusSchema = z.object({
  /** Currently active backend for this workspace (after override resolution) */
  activeBackend: z.string(),
  /** Platform default backend (no workspace override) */
  platformDefault: z.string(),
  /** Workspace override backend (if set) */
  workspaceOverride: z.string().nullable(),
  /** Custom sidecar URL (if set at workspace level) */
  workspaceSidecarUrl: z.string().nullable(),
  /** All available backends in this deployment */
  availableBackends: z.array(SandboxBackendSchema),
  /** Connected BYOC sandbox providers for this org */
  connectedProviders: z.array(ConnectedProviderSchema),
});

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

adminSandbox.use(requireOrgContext());
// F-53 — sandbox backend selection is a settings cluster surface.
adminSandbox.use(requirePermission("admin:settings"));

// GET /status — sandbox backend status for this workspace
adminSandbox.openapi(getStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;
      if (!orgId) {
        return c.json({ error: "Bad Request", message: "No active organization." }, 400);
      }

      // Workspace override
      const workspaceOverride = getSetting("ATLAS_SANDBOX_BACKEND", orgId) ?? null;
      const workspaceSidecarUrl = getSetting("ATLAS_SANDBOX_URL", orgId) ?? null;

      // Platform default (the backend that would be used without any workspace override)
      const platformDefault = getExploreBackendType();
      const activePluginId = getActiveSandboxPluginId();
      const [allBackends, credentials] = yield* Effect.promise(() =>
        Promise.all([getAvailableBackends(), getSandboxCredentials(orgId)]),
      );

      // Resolve the effective active backend
      let activeBackend: string;
      if (workspaceOverride) {
        // Verify the override backend is actually available
        const found = allBackends.find((b) => b.id === workspaceOverride && b.available);
        activeBackend = found ? workspaceOverride : platformDefault;
      } else {
        activeBackend = activePluginId ?? platformDefault;
      }

      // Build connected providers list
      const connectedProviders = credentials.map((cred) => ({
        provider: cred.provider,
        displayName: cred.displayName,
        connectedAt: cred.connectedAt,
        validatedAt: cred.validatedAt,
        isActive: workspaceOverride === cred.provider,
      }));

      return c.json(
        {
          activeBackend,
          platformDefault: activePluginId ?? platformDefault,
          workspaceOverride,
          workspaceSidecarUrl,
          availableBackends: allBackends,
          connectedProviders,
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
      const { orgId } = yield* AuthContext;
      if (!orgId) {
        return c.json({ error: "Bad Request", message: "No active organization." }, 400);
      }
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
      const { orgId } = yield* AuthContext;
      if (!orgId) {
        return c.json({ error: "Bad Request", message: "No active organization." }, 400);
      }
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

      // If this was the active sandbox, reset to platform default
      const workspaceOverride = getSetting("ATLAS_SANDBOX_BACKEND", orgId);
      if (workspaceOverride === provider) {
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
