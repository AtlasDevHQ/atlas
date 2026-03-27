/**
 * Admin sandbox routes.
 *
 * Mounted under /api/v1/admin/sandbox. All routes require admin role
 * and org context. Provides sandbox backend status and selection.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";
import {
  getExploreBackendType,
  getActiveSandboxPluginId,
} from "@atlas/api/lib/tools/explore";
import { useVercelSandbox, useSidecar } from "@atlas/api/lib/tools/backends/detect";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

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
    "including available backends, the active backend, and any workspace override.",
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
    log.debug({ err: detail }, "Plugin registry not available — only built-in backends shown");
  }

  return backends;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminSandbox = createAdminRouter();

adminSandbox.use(requireOrgContext());

// GET /status — sandbox backend status for this workspace
adminSandbox.openapi(getStatusRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      const { orgId } = yield* AuthContext;

      // Workspace override
      const workspaceOverride = getSetting("ATLAS_SANDBOX_BACKEND", orgId) ?? null;
      const workspaceSidecarUrl = getSetting("ATLAS_SANDBOX_URL", orgId) ?? null;

      // Platform default (the backend that would be used without any workspace override)
      const platformDefault = getExploreBackendType();
      const activePluginId = getActiveSandboxPluginId();
      const allBackends = await getAvailableBackends();

      // Resolve the effective active backend
      let activeBackend: string;
      if (workspaceOverride) {
        // Verify the override backend is actually available
        const found = allBackends.find((b) => b.id === workspaceOverride && b.available);
        activeBackend = found ? workspaceOverride : platformDefault;
      } else {
        activeBackend = activePluginId ?? platformDefault;
      }

      return c.json(
        {
          activeBackend,
          platformDefault: activePluginId ?? platformDefault,
          workspaceOverride,
          workspaceSidecarUrl,
          availableBackends: allBackends,
        },
        200,
      );
    }),
    { label: "get sandbox status" },
  );
});

export { adminSandbox };
