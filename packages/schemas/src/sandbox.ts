/**
 * Sandbox wire-format schemas — BYOC provider keys + `/admin/sandbox/status`.
 *
 * Single source of truth for the BYOC sandbox provider vocabulary (#3371).
 * Before this module, the provider enum was hand-mirrored between
 * `packages/api/src/lib/sandbox/credentials.ts` and the web sandbox admin
 * page, and the two halves of the system spoke different vocabularies:
 * connect/disconnect routes use provider keys (`"e2b"`), while the
 * `ATLAS_SANDBOX_BACKEND` workspace setting and the explore runtime use
 * backend ids (`"e2b-sandbox"`). `SANDBOX_PROVIDER_BACKEND_IDS` is the one
 * statement of that mapping; `normalizeSandboxBackendValue` is the
 * compatibility shim for values stored before the vocabulary was unified.
 */
import { z } from "zod";

/**
 * BYOC sandbox provider keys. Used as the URL segment of
 * `/api/v1/admin/sandbox/{connect,disconnect}/{provider}` and as the
 * `provider` column of `sandbox_credentials`.
 */
export const SANDBOX_PROVIDER_KEYS = ["vercel", "e2b", "daytona", "railway"] as const;

export const SandboxProviderKeySchema = z.enum(SANDBOX_PROVIDER_KEYS);

export type SandboxProviderKey = z.infer<typeof SandboxProviderKeySchema>;

/**
 * Maps each BYOC provider key to the sandbox backend id the explore runtime
 * resolves (`getExploreBackend`) and the `ATLAS_SANDBOX_BACKEND` workspace
 * setting stores. Backend ids are the plugin ids registered by
 * `plugins/{vercel-sandbox,e2b,daytona,railway-sandbox}` — `vercel-sandbox`
 * doubles as a built-in backend name when the plugin isn't installed.
 */
export const SANDBOX_PROVIDER_BACKEND_IDS: Record<SandboxProviderKey, string> = {
  vercel: "vercel-sandbox",
  e2b: "e2b-sandbox",
  daytona: "daytona-sandbox",
  railway: "railway-sandbox",
};

/**
 * Normalize an `ATLAS_SANDBOX_BACKEND` value to backend-id vocabulary.
 *
 * Legacy workspaces may have stored bare provider keys (`"e2b"`) before
 * #3375 unified the setting on backend ids — the SaaS admin page wrote
 * provider keys, which matched neither the built-in backend names nor any
 * plugin id and silently fell through to the platform default. Readers of
 * the setting normalize through this function so those stored values keep
 * working; any non-provider-key value (backend ids, built-in names, custom
 * plugin ids) passes through unchanged.
 */
export function normalizeSandboxBackendValue(value: string): string {
  const parsed = SandboxProviderKeySchema.safeParse(value);
  return parsed.success ? SANDBOX_PROVIDER_BACKEND_IDS[parsed.data] : value;
}

// ── /api/v1/admin/sandbox/status wire shapes ──────────────────────
// Shared by the API route's OpenAPI contract and the web admin page's
// `useAdminFetch` response parse, so the two can't drift (#3371).

export const SandboxBackendSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["built-in", "plugin"]),
  available: z.boolean(),
  description: z.string().optional(),
});

export type SandboxBackend = z.infer<typeof SandboxBackendSchema>;

export const SandboxConnectedProviderSchema = z.object({
  provider: SandboxProviderKeySchema,
  displayName: z.string().nullable(),
  connectedAt: z.string(),
  validatedAt: z.string().nullable(),
  /**
   * True when the workspace's resolved active backend is this provider's
   * backend id (`SANDBOX_PROVIDER_BACKEND_IDS[provider]`). Derived from
   * `activeBackend` so the two fields can never contradict (#3375).
   */
  isActive: z.boolean(),
});

export type SandboxConnectedProvider = z.infer<typeof SandboxConnectedProviderSchema>;

export const SandboxStatusSchema = z.object({
  /** Currently active backend id for this workspace (after override resolution) */
  activeBackend: z.string(),
  /** Platform default backend id (no workspace override) */
  platformDefault: z.string(),
  /**
   * Workspace override backend id (if set). Normalized to backend-id
   * vocabulary — legacy stored provider keys are reported as their
   * backend ids.
   */
  workspaceOverride: z.string().nullable(),
  /** Custom sidecar URL (if set at workspace level) */
  workspaceSidecarUrl: z.string().nullable(),
  /** All available backends in this deployment */
  availableBackends: z.array(SandboxBackendSchema),
  /** Connected BYOC sandbox providers for this org */
  connectedProviders: z.array(SandboxConnectedProviderSchema),
});

export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;
