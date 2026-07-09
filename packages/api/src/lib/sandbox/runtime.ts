/**
 * BYOC sandbox runtime — builds per-org explore and Python backends from
 * stored `sandbox_credentials` rows (#3370, #3410).
 *
 * The /admin/sandbox connect flow validates and stores provider credentials;
 * this module is the runtime consumer. `tryCreateByocBackend` is called from
 * the explore tool's workspace-override branch and returns:
 *
 *   • `null`   — BYOC is *not engaged* for this (org, backend): the backend
 *                id isn't a BYOC provider's id (the common case — built-ins
 *                and custom plugin ids), no stored credentials, credentials
 *                missing runtime-required fields, or the provider runtime
 *                isn't installed in this deployment. The caller falls
 *                through to the operator-configured chain (the operator
 *                *instance* — never operator credentials injected into an
 *                org-credential path, per the #2850 seam).
 *   • backend  — BYOC engaged: backend built from the org's decrypted
 *                credentials, on the org's own provider account.
 *   • throws   — BYOC engaged but construction failed, or the runtime is
 *                installed yet failed to load (a deployment defect, not the
 *                stable "not installed" state). Callers must fail closed
 *                (surface the error) rather than silently degrade to the
 *                operator's account: the admin selected this provider
 *                expecting isolation on their own infrastructure.
 *
 * `tryCreateByocPythonBackend` (#3410) is the Python-tool counterpart with the
 * same tri-state contract, plus a capability gate: only providers in
 * `PYTHON_CAPABLE_PROVIDERS` can run Python (see that constant for why), and
 * an incapable provider is *not engaged* for Python — the tool falls through
 * to the operator chain while explore stays on the org's account. Python
 * backends are per-request (python.ts builds a fresh one each call and
 * re-reads credentials), so unlike explore there is no cached backend to
 * drain on credential edits.
 *
 * Credentials are decrypted by `credentials.ts` (db/secret-encryption.ts).
 * This module never logs *stored* credential values — only provider names
 * and the *names* of missing fields. Provider SDK error text (which may
 * echo a rejected key) is confined to operator-level logs and the thrown
 * error's `cause`; the thrown *message* — which becomes agent tool output —
 * stays generic.
 */

import {
  SANDBOX_PROVIDER_BACKEND_IDS,
  type SandboxProviderKey,
} from "@useatlas/schemas";
import type { ExploreBackend } from "@atlas/api/lib/tools/backends/types";
import type { PythonBackend, PythonResult } from "@atlas/api/lib/tools/python";
import type { PythonSandboxOptions } from "@atlas/api/lib/tools/python-sandbox";
import type { VercelSandboxAccessOverride } from "@atlas/api/lib/tools/explore-sandbox";
import type { SandboxNetworkPolicy } from "@atlas/api/lib/tools/backends/network-allowlist";
import { redactedSecret } from "@atlas/api/lib/tools/backends/detect";
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

/** Options for BYOC *Python* backend construction (#3410). */
export interface ByocPythonOptions {
  readonly networkPolicy?: SandboxNetworkPolicy;
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
  /**
   * Build a *Python* backend from the same stored credentials (#3410).
   * Optional — the presence of this method IS the provider's Python
   * capability (`providerSupportsPython` derives from it), so adding Python
   * support for a provider is a single edit to its entry here and capability
   * can never drift from implementation. Python needs more than the
   * explore-shaped plugin exec surface (file upload, an interpreter, package
   * install, the per-request egress allowlist #2927), which is why
   * e2b/daytona/railway — whose backends come from sandbox plugins with an
   * explore-only contract — don't carry it yet (plugin-SDK capability work
   * split out of #3410).
   */
  createPython?(
    options: ByocPythonOptions,
    credentials: Record<string, unknown>,
    load: ModuleLoader,
  ): Promise<PythonBackend>;
}

/**
 * The @vercel/sandbox explicit-auth triple from a stored vercel credentials
 * blob. One construction site shared by the explore and Python runtimes so a
 * shape change (e.g. a new required field) can't update one and miss the
 * other. Completeness is guaranteed upstream by `missingCredentialFields`.
 */
function vercelAccessOverride(
  credentials: Record<string, unknown>,
): VercelSandboxAccessOverride {
  return {
    teamId: credentials.teamId as string,
    projectId: credentials.projectId as string,
    token: redactedSecret(credentials.accessToken as string),
  };
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
      // Same guard one level deeper: a factory from an incompatible plugin
      // version could return a differently-shaped object, and without this
      // check the resulting TypeError would be misreported to the admin as
      // a credentials problem.
      if (typeof plugin?.sandbox?.create !== "function") {
        throw new Error(
          `${packageName}'s ${factoryExport}() returned a plugin without sandbox.create() — incompatible plugin version installed`,
        );
      }
      return await plugin.sandbox.create(semanticRoot);
    },
  };
}

const PROVIDER_RUNTIMES: Record<SandboxProviderKey, ProviderRuntime> = {
  // Vercel uses the in-tree backend. @vercel/sandbox is an
  // *optionalDependency* of @atlas/api — installed in every supported
  // deployment, but probed here so a deployment where the optional install
  // failed reports the card as Unavailable instead of failing at the first
  // explore call. The published @useatlas/vercel-sandbox plugin's
  // access-token mode (as of 0.0.5) passes an `accessToken` field
  // @vercel/sandbox v2 ignores — the SDK requires the full
  // { token, teamId, projectId } triple, which the in-tree backend forwards
  // correctly.
  vercel: {
    requiredModules: ["@vercel/sandbox"],
    async create(semanticRoot, credentials, load) {
      const mod = (await load("@atlas/api/lib/tools/explore-sandbox")) as {
        createSandboxBackend(
          semanticRoot: string,
          access?: VercelSandboxAccessOverride,
        ): Promise<ExploreBackend>;
      };
      // scrubErrorDetail: the backend logs provider errors itself, before
      // this module's catch-site scrub can intervene — a 401 echoing the
      // rejected token must be redacted at the source (#3413).
      return await mod.createSandboxBackend(semanticRoot, {
        ...vercelAccessOverride(credentials),
        scrubErrorDetail: (detail) => scrubCredentialValues(detail, credentials),
      });
    },
    // Python runs on the same in-tree @vercel/sandbox path as explore — see
    // the interface doc for why only vercel carries this method today.
    async createPython(options, credentials, load) {
      const mod = (await load("@atlas/api/lib/tools/python-sandbox")) as {
        createPythonSandboxBackend(options?: PythonSandboxOptions): PythonBackend;
      };
      return mod.createPythonSandboxBackend({
        ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
        access: vercelAccessOverride(credentials),
        scrubErrorDetail: (detail) => scrubCredentialValues(detail, credentials),
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
const runtimeAvailabilityCache = new Map<
  SandboxProviderKey,
  Promise<RuntimeProbeResult>
>();

function isModuleNotFound(err: unknown): boolean {
  const code =
    err != null && typeof err === "object" && "code" in err
      ? (err as NodeJS.ErrnoException).code
      : undefined;
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

type RuntimeProbeResult =
  | { available: true }
  | { available: false; reason: "not-installed" }
  | { available: false; reason: "load-failed"; module: string; error: unknown };

/**
 * Probe a provider's required modules. Two distinct negative outcomes:
 *
 *   • `not-installed` — module resolution failed. Stable per process and
 *     cached; this is the state the admin UI surfaces as "Unavailable".
 *   • `load-failed`   — the module resolved but its import threw (broken
 *     install, incompatible version, transient init failure). NOT cached,
 *     so the next probe retries; engaged BYOC callers treat it as a
 *     deployment defect and fail closed rather than silently running the
 *     org's workload on the operator chain.
 */
function probeProviderRuntime(
  provider: SandboxProviderKey,
  load: ModuleLoader,
): Promise<RuntimeProbeResult> {
  const cached = runtimeAvailabilityCache.get(provider);
  if (cached) return cached;
  const probe = (async (): Promise<RuntimeProbeResult> => {
    for (const specifier of PROVIDER_RUNTIMES[provider].requiredModules) {
      try {
        await load(specifier);
      } catch (err) {
        if (isModuleNotFound(err)) {
          log.debug(
            { provider, module: specifier },
            "BYOC provider runtime module not installed",
          );
          return { available: false, reason: "not-installed" };
        }
        runtimeAvailabilityCache.delete(provider); // retry on next probe
        log.warn(
          { provider, module: specifier, err: err instanceof Error ? err.message : String(err) },
          "BYOC provider runtime module is installed but failed to load",
        );
        return { available: false, reason: "load-failed", module: specifier, error: err };
      }
    }
    return { available: true };
  })();
  runtimeAvailabilityCache.set(provider, probe);
  return probe;
}

/**
 * Whether this deployment can construct BYOC backends for a provider
 * (plugin package + provider SDK resolvable). Boolean view of the probe
 * for the status endpoint — a load-failed runtime reports unavailable
 * here, while the engagement path in `tryCreateByocBackend` fails closed
 * on it instead of falling through.
 */
export async function isProviderRuntimeAvailable(
  provider: SandboxProviderKey,
  load: ModuleLoader = dynamicImport,
): Promise<boolean> {
  return (await probeProviderRuntime(provider, load)).available;
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

/**
 * Replace every stored credential value appearing in `text` with a redaction
 * marker. Exact-match against the org's own decrypted values — no pattern
 * guessing — so a provider SDK error that echoes the rejected key can be
 * logged without retaining the secret. Short values (< 6 chars) are skipped:
 * they can't meaningfully be secrets and would shred ordinary words.
 */
function scrubCredentialValues(
  text: string,
  credentials: Record<string, unknown>,
): string {
  let scrubbed = text;
  for (const value of Object.values(credentials)) {
    if (typeof value === "string" && value.length >= 6) {
      scrubbed = scrubbed.split(value).join("[REDACTED]");
    }
  }
  return scrubbed;
}

export const _scrubCredentialValuesForTest = scrubCredentialValues;

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
 * Shared engagement gate for explore and Python BYOC paths. Returns the
 * stored credential when BYOC is engaged for `(orgId, provider)` — stored
 * credentials present, runtime-required fields complete, provider runtime
 * loadable. Returns `null` when not engaged (caller falls through to the
 * operator chain); throws (fail closed) when the runtime is installed but
 * failed to load — a deployment defect, not the stable "not installed" state.
 */
async function resolveEngagedCredential(
  orgId: string,
  provider: SandboxProviderKey,
  deps: ByocDeps,
): Promise<SandboxCredential | null> {
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

  const probe = await probeProviderRuntime(provider, load);
  if (!probe.available) {
    if (probe.reason === "load-failed") {
      // The org did everything right (connected + selected + complete creds)
      // and the runtime IS installed — it just failed to load. That's a
      // deployment defect; fail closed instead of silently running the
      // org's workload on the operator chain.
      log.error(
        { orgId, provider, module: probe.module },
        "BYOC provider runtime is installed but failed to load — failing closed",
      );
      throw new Error(
        `Your connected ${provider} sandbox runtime failed to load on this server. ` +
          "This is a deployment problem, not a credentials problem — contact your operator, " +
          "or switch back to the platform default.",
        { cause: probe.error },
      );
    }
    log.warn(
      { orgId, provider },
      "BYOC provider runtime is not installed in this deployment — using operator chain",
    );
    return null;
  }

  return credential;
}

/**
 * Scrub, log, and wrap a construction failure on an *engaged* BYOC path
 * (fail closed). Provider SDK errors can echo the rejected credential, so
 * the operator-log detail is exact-match scrubbed against the org's own
 * decrypted values — keeps the log diagnosable without retaining a secret.
 * The returned error's *message* — which becomes agent tool output (the
 * error-scrub layer only handles URL-embedded credentials) — stays generic;
 * the raw error rides on `cause` only. One construction site for both the
 * explore and Python paths so the admin guidance can't diverge.
 */
function engagedConstructionFailure(
  orgId: string,
  provider: SandboxProviderKey,
  credentials: Record<string, unknown>,
  err: unknown,
  label: string,
): Error {
  const detail = scrubCredentialValues(
    err instanceof Error ? err.message : String(err),
    credentials,
  );
  log.error({ orgId, provider, err: detail }, `${label} creation failed`);
  return new Error(
    `Your connected ${provider} sandbox failed to start. ` +
      "Check the provider credentials on the Sandbox admin page, or switch back to the platform default.",
    { cause: err },
  );
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

  const load = deps.load ?? dynamicImport;
  const credential = await resolveEngagedCredential(orgId, provider, deps);
  if (!credential) return null;

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
    throw engagedConstructionFailure(
      orgId,
      provider,
      credential.credentials,
      err,
      "BYOC sandbox backend",
    );
  }
}

// ---------------------------------------------------------------------------
// Python backend construction (#3410)
// ---------------------------------------------------------------------------

/**
 * Whether a BYOC provider's selection covers the Python tool (#3410).
 * Derived from the runtime table — a provider supports Python exactly when
 * its `ProviderRuntime` declares `createPython`, so capability can never
 * drift from implementation (see the interface doc for why only vercel
 * carries it today). An unsupported provider is *not engaged* for Python:
 * the tool falls through to the operator chain (and the docs say so) rather
 * than failing closed — the org's explore isolation still applies, and
 * hard-erroring Python for every e2b/daytona/railway org would break the
 * tool with no recovery path the org controls.
 */
export function providerSupportsPython(provider: SandboxProviderKey): boolean {
  return PROVIDER_RUNTIMES[provider].createPython !== undefined;
}

/**
 * Build a BYOC Python backend for `(orgId, backendId)` from stored
 * credentials. Same tri-state contract as {@link tryCreateByocBackend}:
 * `null` when not engaged (non-BYOC id, provider without Python support,
 * no/incomplete credentials, runtime not installed); throws when engaged
 * but unusable — callers fail closed, never the operator chain.
 *
 * `getOptions` supplies the per-request REST egress allowlist (#2927
 * layer 0) — the org's own sandbox gets the same egress bound as the
 * platform one. It is invoked only once BYOC is engaged, so callers can
 * defer the datasource resolve behind it until it's known to be needed
 * (a selected-but-unusable override costs no extra I/O).
 *
 * Construction is lazy (the sandbox is created on first `exec`), so provider
 * failures surface as `{ success: false }` results rather than throws; the
 * wrapper below scrubs stored credential values from those error messages
 * before they reach agent tool output.
 */
export async function tryCreateByocPythonBackend(
  orgId: string,
  backendId: string,
  getOptions: () => Promise<ByocPythonOptions> = async () => ({}),
  deps: ByocDeps = {},
): Promise<PythonBackend | null> {
  const provider = sandboxProviderForBackendId(backendId);
  if (!provider) return null;

  const createPython = PROVIDER_RUNTIMES[provider].createPython?.bind(PROVIDER_RUNTIMES[provider]);
  if (!createPython) {
    log.debug(
      { orgId, provider, backendId },
      "BYOC provider has no Python runtime support — Python uses the operator chain (explore still runs on org credentials)",
    );
    return null;
  }

  const load = deps.load ?? dynamicImport;
  const credential = await resolveEngagedCredential(orgId, provider, deps);
  if (!credential) return null;

  // Engaged: errors from here propagate (fail closed).
  let inner: PythonBackend;
  try {
    inner = await createPython(await getOptions(), credential.credentials, load);
  } catch (err) {
    throw engagedConstructionFailure(
      orgId,
      provider,
      credential.credentials,
      err,
      "BYOC Python backend",
    );
  }

  log.info({ orgId, provider, backendId }, "BYOC Python backend created from org credentials");

  // Provider error text can echo the rejected credential (the lazy backend
  // maps infra failures to result objects, so the throw-site scrub above
  // never sees them). Exact-match scrub against the org's own stored values
  // before the message becomes agent tool output.
  const scrub = (result: PythonResult): PythonResult =>
    result.success
      ? result
      : { ...result, error: scrubCredentialValues(result.error, credential.credentials) };

  return {
    exec: async (code, data) => scrub(await inner.exec(code, data)),
    // Mirror an inner execStream so a future streaming python backend
    // neither silently loses the capability here nor bypasses the scrub.
    ...(inner.execStream
      ? {
          execStream: async (
            code: string,
            data: { columns: string[]; rows: unknown[][] } | undefined,
            onProgress: Parameters<NonNullable<PythonBackend["execStream"]>>[2],
          ) => scrub(await inner.execStream!(code, data, onProgress)),
        }
      : {}),
  };
}
