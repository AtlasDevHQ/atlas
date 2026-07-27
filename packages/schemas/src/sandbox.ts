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
  /**
   * True when the stored credentials are missing fields the runtime now
   * requires (e.g. a Vercel row stored before `projectId` was collected).
   * The provider must be reconnected before it can run (#3370). Optional:
   * absent on responses from API versions predating the field.
   */
  needsReconnect: z.boolean().optional(),
});

export type SandboxConnectedProvider = z.infer<typeof SandboxConnectedProviderSchema>;

/**
 * The deployment is FAIL-CLOSED: no sandbox backend will construct, so the
 * explore tool refuses every request.
 *
 * A separate object rather than a `"fail-closed"` string in `activeBackend`,
 * and that is the whole point (#4837). Backend ids are open (`z.string()` —
 * plugins register their own), so a sentinel living in that field is
 * indistinguishable AT THE TYPE LEVEL from a selectable backend: consumers
 * rendered it in the same monospace slot as `vercel-sandbox`, and
 * `activeBackend === "sidecar"`-style comparisons silently treated an outage as
 * a selection. #4835 refused to widen `BACKEND_ISOLATION` with this value for
 * the same reason; hoisting it out of the id field is that precedent applied to
 * the wire. Presence of this field is now the only way to say it, and the
 * accompanying `null` ids make every consumer handle it or fail to compile.
 */
export const SandboxFailClosedSchema = z.object({
  /**
   * Operator-facing remediation naming the ACTUAL cause — the pinned backends
   * and the credential each one needs (`VERCEL_TOKEN` under the SaaS
   * `priority: ["vercel-sandbox"]` pin). Server-composed, byte-identical to the
   * boot warning, so `/admin/sandbox`, `/api/health` and the startup log cannot
   * give an operator three different stories about one outage.
   *
   * Deliberately not a generic "install nsjail / set ATLAS_SANDBOX_URL" line:
   * a priority pin that excludes those backends makes that advice impossible to
   * act on and hides the real cause (#4828).
   */
  remediation: z.string(),
});

export type SandboxFailClosed = z.infer<typeof SandboxFailClosedSchema>;

export const SandboxStatusSchema = z.object({
  /**
   * Currently active backend id for this workspace (after override resolution),
   * or `null` when this workspace's explore is fail-closed — see
   * {@link SandboxFailClosedSchema}.
   *
   * Can be a real backend id while `platformDefault` is `null`: a workspace BYOC
   * override sits ahead of the platform plan and keeps running when the
   * platform default has failed closed.
   */
  activeBackend: z.string().nullable(),
  /**
   * Platform default backend id (no workspace override), or `null` when the
   * deployment's own plan resolves fail-closed. `null` here is exactly the
   * condition under which `failClosed` is present.
   */
  platformDefault: z.string().nullable(),
  /**
   * Present if and only if `platformDefault` is `null` — the deployment's
   * sandbox plan constructs nothing. Optional (rather than nullable) so a
   * healthy deployment's payload is unchanged from before #4837 and older web
   * bundles keep parsing it; only the already-broken fail-closed payload is new.
   */
  failClosed: SandboxFailClosedSchema.optional(),
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
  /**
   * Whether this deployment can run each BYOC provider at runtime (provider
   * plugin + SDK resolvable). `false` means the provider cannot execute even
   * with valid stored credentials (#3370). Consumers treat an absent key —
   * and the absent field on API versions predating it — as *unknown* and
   * assume usable: the optimistic default keeps older-API admin pages
   * functional, and the connect/explore paths enforce the real check
   * server-side. Keys are deliberately `z.string()` rather than
   * `SandboxProviderKeySchema`: an enum-keyed record would make a newer API
   * (with a fifth provider) fail this whole parse on an older web bundle
   * during the deploy-overlap window.
   */
  providerRuntimeAvailability: z.record(z.string(), z.boolean()).optional(),
});

export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;
