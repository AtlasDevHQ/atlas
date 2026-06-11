/**
 * BYOC sandbox runtime — builds per-org explore backends from stored
 * `sandbox_credentials` rows (#3370).
 *
 * The /admin/sandbox connect flow validates and stores provider credentials;
 * this module is the runtime consumer. `tryCreateByocBackend` is called from
 * the explore tool's workspace-override branch and returns:
 *
 *   • `null`   — BYOC is *not engaged* for this (org, backend): no stored
 *                credentials, credentials missing runtime-required fields,
 *                or the provider runtime isn't installed in this deployment.
 *                The caller falls through to the operator-configured chain
 *                (the operator *instance* — never operator credentials
 *                injected into an org-credential path, per the #2850 seam).
 *   • backend  — BYOC engaged: backend built from the org's decrypted
 *                credentials, on the org's own provider account.
 *   • throws   — BYOC engaged but construction failed. Callers must fail
 *                closed (surface the error) rather than silently degrade to
 *                the operator's account: the admin selected this provider
 *                expecting isolation on their own infrastructure.
 *
 * Credentials are decrypted by `credentials.ts` (db/secret-encryption.ts);
 * this module never logs credential values — only provider names and the
 * *names* of missing fields.
 */

import {
  SANDBOX_PROVIDER_BACKEND_IDS,
  type SandboxProviderKey,
} from "@useatlas/schemas";
import type { ExploreBackend } from "@atlas/api/lib/tools/backends/types";
import { createLogger } from "@atlas/api/lib/logger";
import {
  getSandboxCredentialByProvider,
  SANDBOX_PROVIDERS,
  type SandboxCredential,
} from "./credentials";

const log = createLogger("sandbox-byoc");

// ---------------------------------------------------------------------------
// Backend-id ↔ provider mapping
// ---------------------------------------------------------------------------

const BACKEND_ID_PROVIDERS: ReadonlyMap<string, SandboxProviderKey> = new Map(
  (Object.entries(SANDBOX_PROVIDER_BACKEND_IDS) as [SandboxProviderKey, string][]).map(
    ([provider, backendId]) => [backendId, provider],
  ),
);

/** Inverse of SANDBOX_PROVIDER_BACKEND_IDS: backend id → BYOC provider key. */
export function sandboxProviderForBackendId(
  backendId: string,
): SandboxProviderKey | null {
  return BACKEND_ID_PROVIDERS.get(backendId) ?? null;
}

// ---------------------------------------------------------------------------
// Credential completeness
// ---------------------------------------------------------------------------

/**
 * Fields a stored credential row must carry for the runtime to construct a
 * backend. Stricter than the historical connect-time validation in two ways:
 *
 *   • vercel: `projectId` — @vercel/sandbox v2 requires the full
 *     token/teamId/projectId triple for explicit (off-OIDC) auth; rows
 *     stored before the connect flow collected projectId can't create a
 *     sandbox and must be reconnected.
 *   • railway: `environmentId` — the railway plugin falls back to the
 *     operator's RAILWAY_ENVIRONMENT_ID env var when omitted, which would
 *     mix org and operator config. BYOC requires it stored explicitly.
 */
const REQUIRED_CREDENTIAL_FIELDS: Record<SandboxProviderKey, readonly string[]> = {
  vercel: ["accessToken", "teamId", "projectId"],
  e2b: ["apiKey"],
  daytona: ["apiKey"],
  railway: ["token", "environmentId"],
};

/**
 * Names of runtime-required fields absent from a stored credentials blob.
 * Empty array = usable. Also consumed by the admin status route to surface
 * `needsReconnect` on rows stored before a field became required.
 */
export function missingCredentialFields(
  provider: SandboxProviderKey,
  credentials: Record<string, unknown>,
): string[] {
  return REQUIRED_CREDENTIAL_FIELDS[provider].filter((field) => {
    const value = credentials[field];
    return typeof value !== "string" || value.length === 0;
  });
}

// ---------------------------------------------------------------------------
// Provider runtimes
// ---------------------------------------------------------------------------

/**
 * Loads a module by specifier. Injectable for tests. The default uses a
 * computed-specifier dynamic import so bundlers (the create-atlas Next.js
 * template) can't statically resolve the optional plugin packages.
 */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

const dynamicImport: ModuleLoader = (specifier) => import(specifier);

interface SandboxPluginLike {
  sandbox: {
    create(semanticRoot: string): Promise<ExploreBackend> | ExploreBackend;
  };
}

interface ProviderRuntime {
  /**
   * Modules that must be resolvable for this provider to run. The plugin
   * package wraps the provider SDK, but loads it lazily — probing both is
   * what lets the status endpoint report "unavailable on this deployment"
   * instead of failing at first explore call.
   */
  readonly requiredModules: readonly string[];
  /** Build a backend from a stored, completeness-checked credentials blob. */
  create(
    semanticRoot: string,
    credentials: Record<string, unknown>,
    load: ModuleLoader,
  ): Promise<ExploreBackend>;
}

/** Build via a published `@useatlas/*` sandbox plugin factory. */
function pluginRuntime(
  packageName: string,
  sdkModule: string,
  factoryExport: string,
  mapConfig: (creds: Record<string, unknown>) => Record<string, unknown>,
): ProviderRuntime {
  return {
    requiredModules: [packageName, sdkModule],
    async create(semanticRoot, credentials, load) {
      const mod = (await load(packageName)) as Record<string, unknown>;
      const factory = mod[factoryExport];
      if (typeof factory !== "function") {
        throw new Error(
          `${packageName} does not export ${factoryExport}() — incompatible plugin version installed`,
        );
      }
      const plugin = factory(mapConfig(credentials)) as SandboxPluginLike;
      return await plugin.sandbox.create(semanticRoot);
    },
  };
}

const PROVIDER_RUNTIMES: Record<SandboxProviderKey, ProviderRuntime> = {
  // Vercel uses the in-tree backend (@vercel/sandbox is a regular dependency
  // of @atlas/api, so this provider is runtime-available in every deployment).
  // The published @useatlas/vercel-sandbox plugin's access-token mode passes
  // an `accessToken` field @vercel/sandbox v2 ignores — the SDK requires the
  // full { token, teamId, projectId } triple, which the in-tree backend
  // forwards correctly.
  vercel: {
    requiredModules: [],
    async create(semanticRoot, credentials, load) {
      const mod = (await load("@atlas/api/lib/tools/explore-sandbox")) as {
        createSandboxBackend(
          semanticRoot: string,
          access?: { teamId: string; projectId: string; token: string },
        ): Promise<ExploreBackend>;
      };
      return await mod.createSandboxBackend(semanticRoot, {
        teamId: credentials.teamId as string,
        projectId: credentials.projectId as string,
        token: credentials.accessToken as string,
      });
    },
  },
  e2b: pluginRuntime("@useatlas/e2b", "e2b", "e2bSandboxPlugin", (creds) => ({
    apiKey: creds.apiKey,
  })),
  daytona: pluginRuntime(
    "@useatlas/daytona",
    "@daytonaio/sdk",
    "daytonaSandboxPlugin",
    (creds) => ({
      apiKey: creds.apiKey,
      ...(typeof creds.apiUrl === "string" && creds.apiUrl
        ? { apiUrl: creds.apiUrl }
        : {}),
    }),
  ),
  // Both fields passed explicitly — the plugin's env-var fallback
  // (RAILWAY_API_TOKEN / RAILWAY_ENVIRONMENT_ID) must never fill in for an
  // org-credential path (#2850).
  railway: pluginRuntime(
    "@useatlas/railway-sandbox",
    "railway",
    "railwaySandboxPlugin",
    (creds) => ({
      token: creds.token,
      environmentId: creds.environmentId,
    }),
  ),
};

/** Per-process probe cache — module installation can't change at runtime. */
const runtimeAvailabilityCache = new Map<SandboxProviderKey, Promise<boolean>>();

/**
 * Whether this deployment can construct BYOC backends for a provider
 * (plugin package + provider SDK resolvable). Vercel is always available.
 */
export function isProviderRuntimeAvailable(
  provider: SandboxProviderKey,
  load: ModuleLoader = dynamicImport,
): Promise<boolean> {
  let cached = runtimeAvailabilityCache.get(provider);
  if (!cached) {
    cached = (async () => {
      for (const specifier of PROVIDER_RUNTIMES[provider].requiredModules) {
        try {
          await load(specifier);
        } catch (err) {
          log.debug(
            { provider, module: specifier, err: err instanceof Error ? err.message : String(err) },
            "BYOC provider runtime module not resolvable",
          );
          return false;
        }
      }
      return true;
    })();
    runtimeAvailabilityCache.set(provider, cached);
  }
  return cached;
}

/** All providers' runtime availability, keyed by provider (status endpoint). */
export async function getProviderRuntimeAvailability(
  load: ModuleLoader = dynamicImport,
): Promise<Record<SandboxProviderKey, boolean>> {
  const entries = await Promise.all(
    SANDBOX_PROVIDERS.map(async (provider) => [
      provider,
      await isProviderRuntimeAvailable(provider, load),
    ] as const),
  );
  return Object.fromEntries(entries) as Record<SandboxProviderKey, boolean>;
}

export function _resetRuntimeAvailabilityCacheForTest(): void {
  runtimeAvailabilityCache.clear();
}

// ---------------------------------------------------------------------------
// Backend construction
// ---------------------------------------------------------------------------

export interface ByocDeps {
  getCredential?: (
    orgId: string,
    provider: SandboxProviderKey,
  ) => Promise<SandboxCredential | null>;
  load?: ModuleLoader;
}

/**
 * Build a BYOC explore backend for `(orgId, backendId)` from stored
 * credentials. Returns `null` when BYOC is not engaged (see module docs);
 * throws when engaged but construction fails — callers fail closed.
 */
export async function tryCreateByocBackend(
  orgId: string,
  backendId: string,
  semanticRoot: string,
  deps: ByocDeps = {},
): Promise<ExploreBackend | null> {
  const provider = sandboxProviderForBackendId(backendId);
  if (!provider) return null;

  const getCredential = deps.getCredential ?? getSandboxCredentialByProvider;
  const load = deps.load ?? dynamicImport;

  const credential = await getCredential(orgId, provider);
  if (!credential) {
    log.debug({ orgId, provider }, "No stored BYOC credentials — using operator chain");
    return null;
  }

  const missing = missingCredentialFields(provider, credential.credentials);
  if (missing.length > 0) {
    log.warn(
      { orgId, provider, missingFields: missing },
      "Stored BYOC credentials are missing runtime-required fields — reconnect the provider on /admin/sandbox; using operator chain",
    );
    return null;
  }

  if (!(await isProviderRuntimeAvailable(provider, load))) {
    log.warn(
      { orgId, provider },
      "BYOC provider runtime is not installed in this deployment — using operator chain",
    );
    return null;
  }

  // Engaged: from here on, errors propagate (fail closed — never silently
  // run the org's workload on the operator's provider account).
  try {
    const backend = await PROVIDER_RUNTIMES[provider].create(
      semanticRoot,
      credential.credentials,
      load,
    );
    log.info({ orgId, provider, backendId }, "BYOC sandbox backend created from org credentials");
    return backend;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ orgId, provider, err: detail }, "BYOC sandbox backend creation failed");
    // The thrown message is surfaced as agent tool output. Provider SDK
    // errors can echo the rejected API key, and the error-scrub layer only
    // handles URL-embedded credentials — so keep the detail in the operator
    // log (above) and on `cause`, never in the message itself.
    throw new Error(
      `Your connected ${provider} sandbox failed to start. ` +
        "Check the provider credentials on the Sandbox admin page, or switch back to the platform default.",
      { cause: err },
    );
  }
}
