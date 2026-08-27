/**
 * Tests for the BYOC sandbox runtime (#3370).
 *
 * Everything is exercised through the module's DI seams (`ByocDeps` /
 * injectable ModuleLoader) — no mock.module, no DB, no network.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { SandboxCredential } from "../credentials";
import type { PythonSandboxOptions } from "@atlas/api/lib/tools/python-sandbox";
import {
  sandboxProviderForBackendId,
  missingCredentialFields,
  isProviderRuntimeAvailable,
  getProviderRuntimeAvailability,
  providerSupportsPython,
  tryCreateByocBackend,
  tryCreateByocPythonBackend,
  _resetRuntimeAvailabilityCacheForTest,
  type ModuleLoader,
} from "../runtime";
import { networkPolicyFromAllowlist } from "@atlas/api/lib/tools/backends/network-allowlist";

function makeCredential(
  provider: SandboxCredential["provider"],
  credentials: Record<string, unknown>,
): SandboxCredential {
  return {
    id: `cred-${provider}`,
    orgId: "org-1",
    provider,
    credentials,
    displayName: null,
    validatedAt: null,
    connectedAt: "2026-06-01T00:00:00.000Z",
  };
}

const SEMANTIC_ROOT = "/tmp/semantic-test";

/** Loader that resolves every module to the given map; rejects others. */
function fakeLoader(modules: Record<string, unknown>): ModuleLoader {
  return async (specifier) => {
    if (specifier in modules) return modules[specifier];
    throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

/** A plugin module whose factory records the config it was called with. */
function fakePluginModule(factoryExport: string, execTag: string) {
  const calls: Record<string, unknown>[] = [];
  const mod = {
    [factoryExport]: (config: Record<string, unknown>) => {
      calls.push(config);
      return {
        sandbox: {
          create: async (_root: string) => ({
            exec: async () => ({ stdout: execTag, stderr: "", exitCode: 0 }),
          }),
        },
      };
    },
  };
  return { mod, calls };
}

beforeEach(() => {
  _resetRuntimeAvailabilityCacheForTest();
});

describe("sandboxProviderForBackendId", () => {
  it("inverts the provider → backend-id map", () => {
    expect(sandboxProviderForBackendId("vercel-sandbox")).toBe("vercel");
    expect(sandboxProviderForBackendId("e2b-sandbox")).toBe("e2b");
    expect(sandboxProviderForBackendId("daytona-sandbox")).toBe("daytona");
    expect(sandboxProviderForBackendId("railway-sandbox")).toBe("railway");
  });

  it("returns null for built-ins and unknown ids", () => {
    expect(sandboxProviderForBackendId("sidecar")).toBeNull();
    expect(sandboxProviderForBackendId("just-bash")).toBeNull();
    expect(sandboxProviderForBackendId("nsjail")).toBeNull();
    expect(sandboxProviderForBackendId("custom-plugin")).toBeNull();
  });
});

describe("missingCredentialFields", () => {
  it("vercel requires the full accessToken/teamId/projectId triple", () => {
    expect(
      missingCredentialFields("vercel", {
        accessToken: "tok",
        teamId: "team_1",
        projectId: "prj_1",
      }),
    ).toEqual([]);
    // Rows stored before the connect flow collected projectId
    expect(
      missingCredentialFields("vercel", { accessToken: "tok", teamId: "team_1" }),
    ).toEqual(["projectId"]);
  });

  it("railway requires environmentId (no operator env-var fallback)", () => {
    expect(
      missingCredentialFields("railway", { token: "t", environmentId: "env-1" }),
    ).toEqual([]);
    expect(missingCredentialFields("railway", { token: "t" })).toEqual([
      "environmentId",
    ]);
  });

  it("rejects empty strings, not just absent fields", () => {
    expect(missingCredentialFields("e2b", { apiKey: "" })).toEqual(["apiKey"]);
    expect(missingCredentialFields("e2b", { apiKey: "k" })).toEqual([]);
  });
});

describe("isProviderRuntimeAvailable", () => {
  it("vercel requires @vercel/sandbox (an optionalDependency) to be resolvable", async () => {
    expect(
      await isProviderRuntimeAvailable("vercel", fakeLoader({ "@vercel/sandbox": {} })),
    ).toBe(true);
    _resetRuntimeAvailabilityCacheForTest();
    // A deployment where the optional install failed must report Unavailable
    // instead of failing at the first explore call.
    expect(await isProviderRuntimeAvailable("vercel", fakeLoader({}))).toBe(false);
  });

  it("does not cache a transient (non-not-found) load failure", async () => {
    let calls = 0;
    const flakyLoader: ModuleLoader = async (specifier) => {
      if (specifier !== "@vercel/sandbox") throw new Error("unexpected module");
      calls++;
      if (calls === 1) throw new Error("init failed under resource pressure");
      return {};
    };
    expect(await isProviderRuntimeAvailable("vercel", flakyLoader)).toBe(false);
    // Not-found is cached; transient failure is not — next probe retries.
    expect(await isProviderRuntimeAvailable("vercel", flakyLoader)).toBe(true);
  });

  it("e2b requires both the plugin package and the SDK", async () => {
    expect(await isProviderRuntimeAvailable("e2b", fakeLoader({}))).toBe(false);
    _resetRuntimeAvailabilityCacheForTest();
    expect(
      await isProviderRuntimeAvailable("e2b", fakeLoader({ "@useatlas/e2b": {} })),
    ).toBe(false);
    _resetRuntimeAvailabilityCacheForTest();
    expect(
      await isProviderRuntimeAvailable(
        "e2b",
        fakeLoader({ "@useatlas/e2b": {}, e2b: {} }),
      ),
    ).toBe(true);
  });

  it("getProviderRuntimeAvailability reports every provider", async () => {
    const availability = await getProviderRuntimeAvailability(
      fakeLoader({ "@vercel/sandbox": {} }),
    );
    expect(availability).toEqual({
      vercel: true,
      e2b: false,
      daytona: false,
      railway: false,
    });
  });
});

describe("tryCreateByocBackend — not engaged (falls through to operator chain)", () => {
  it("returns null for non-BYOC backend ids without touching credentials", async () => {
    let credentialReads = 0;
    const backend = await tryCreateByocBackend("org-1", "sidecar", SEMANTIC_ROOT, {
      getCredential: async () => {
        credentialReads++;
        return null;
      },
      load: fakeLoader({}),
    });
    expect(backend).toBeNull();
    expect(credentialReads).toBe(0);
  });

  it("returns null when the org has no stored credentials", async () => {
    const backend = await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
      getCredential: async () => null,
      load: fakeLoader({ "@useatlas/e2b": {}, e2b: {} }),
    });
    expect(backend).toBeNull();
  });

  it("returns null when stored credentials miss runtime-required fields", async () => {
    // Legacy vercel row without projectId
    const backend = await tryCreateByocBackend("org-1", "vercel-sandbox", SEMANTIC_ROOT, {
      getCredential: async () =>
        makeCredential("vercel", { accessToken: "tok", teamId: "team_1" }),
      load: fakeLoader({}),
    });
    expect(backend).toBeNull();
  });

  it("returns null when the provider runtime is not installed", async () => {
    const backend = await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
      getCredential: async () => makeCredential("e2b", { apiKey: "e2b_key" }),
      load: fakeLoader({}), // neither plugin nor SDK resolvable
    });
    expect(backend).toBeNull();
  });

  it("fails closed (throws) when the runtime is installed but fails to load", async () => {
    // Installed-but-broken is a deployment defect, not the stable
    // "not installed" state — the org's selection must not silently route
    // to the operator chain.
    const brokenLoader: ModuleLoader = async () => {
      throw new Error("incompatible plugin init crashed"); // no not-found code
    };
    let thrown: unknown;
    try {
      await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
        getCredential: async () => makeCredential("e2b", { apiKey: "e2b_key" }),
        load: brokenLoader,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("runtime failed to load");
    expect(((thrown as Error).cause as Error).message).toContain("init crashed");
  });
});

describe("scrubCredentialValues", () => {
  it("redacts stored credential values echoed by provider error text", async () => {
    const { _scrubCredentialValuesForTest } = await import("../runtime");
    const scrubbed = _scrubCredentialValuesForTest(
      "Unauthorized: API key 'e2b_sk_secret123' is invalid (key e2b_sk_secret123 revoked)",
      { apiKey: "e2b_sk_secret123" },
    );
    expect(scrubbed).not.toContain("e2b_sk_secret123");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("skips short values that would shred ordinary words", async () => {
    const { _scrubCredentialValuesForTest } = await import("../runtime");
    expect(
      _scrubCredentialValuesForTest("a team error", { teamId: "team" }),
    ).toBe("a team error");
  });
});

describe("tryCreateByocBackend — engaged", () => {
  it("builds the e2b backend from the stored API key", async () => {
    const { mod, calls } = fakePluginModule("e2bSandboxPlugin", "e2b-byoc");
    const backend = await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
      getCredential: async () => makeCredential("e2b", { apiKey: "e2b_org_key" }),
      load: fakeLoader({ "@useatlas/e2b": mod, e2b: {} }),
    });
    expect(backend).not.toBeNull();
    expect(calls).toEqual([{ apiKey: "e2b_org_key" }]);
    const result = await backend!.exec("ls");
    expect(result.stdout).toBe("e2b-byoc");
  });

  it("builds the daytona backend with optional apiUrl when stored", async () => {
    const { mod, calls } = fakePluginModule("daytonaSandboxPlugin", "daytona-byoc");
    const loader = fakeLoader({ "@useatlas/daytona": mod, "@daytonaio/sdk": {} });

    await tryCreateByocBackend("org-1", "daytona-sandbox", SEMANTIC_ROOT, {
      getCredential: async () =>
        makeCredential("daytona", { apiKey: "d_key", apiUrl: "https://eu.daytona.io" }),
      load: loader,
    });
    expect(calls).toEqual([{ apiKey: "d_key", apiUrl: "https://eu.daytona.io" }]);

    _resetRuntimeAvailabilityCacheForTest();
    calls.length = 0;
    await tryCreateByocBackend("org-1", "daytona-sandbox", SEMANTIC_ROOT, {
      getCredential: async () => makeCredential("daytona", { apiKey: "d_key" }),
      load: loader,
    });
    expect(calls).toEqual([{ apiKey: "d_key" }]);
  });

  it("builds the railway backend passing token AND environmentId explicitly", async () => {
    const { mod, calls } = fakePluginModule("railwaySandboxPlugin", "railway-byoc");
    const backend = await tryCreateByocBackend(
      "org-1",
      "railway-sandbox",
      SEMANTIC_ROOT,
      {
        getCredential: async () =>
          makeCredential("railway", { token: "rw_tok", environmentId: "env-42" }),
        load: fakeLoader({ "@useatlas/railway-sandbox": mod, railway: {} }),
      },
    );
    expect(backend).not.toBeNull();
    // Both fields explicit so the plugin's RAILWAY_* env fallback can never
    // mix operator config into an org-credential path (#2850).
    expect(calls).toEqual([{ token: "rw_tok", environmentId: "env-42" }]);
  });

  it("builds the vercel backend via the in-tree explore-sandbox with the stored triple", async () => {
    const createCalls: Array<{
      root: string;
      access: { teamId: string; projectId: string; token: { reveal(): string; toJSON(): string } };
    }> = [];
    const backend = await tryCreateByocBackend(
      "org-1",
      "vercel-sandbox",
      SEMANTIC_ROOT,
      {
        getCredential: async () =>
          makeCredential("vercel", {
            accessToken: "vc_tok",
            teamId: "team_1",
            projectId: "prj_1",
          }),
        load: fakeLoader({
          "@vercel/sandbox": {},
          "@atlas/api/lib/tools/explore-sandbox": {
            createSandboxBackend: async (root: string, access: (typeof createCalls)[number]["access"]) => {
              createCalls.push({ root, access });
              return {
                exec: async () => ({ stdout: "vercel-byoc", stderr: "", exitCode: 0 }),
              };
            },
          },
        }),
      },
    );
    expect(backend).not.toBeNull();
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].root).toBe(SEMANTIC_ROOT);
    expect(createCalls[0].access.teamId).toBe("team_1");
    expect(createCalls[0].access.projectId).toBe("prj_1");
    // The token is RedactedSecret-branded: revealable at the create site,
    // but serializing it (e.g. an accidental structured log) leaks nothing.
    expect(createCalls[0].access.token.reveal()).toBe("vc_tok");
    expect(JSON.stringify(createCalls[0].access)).not.toContain("vc_tok");
    // The backend logs Sandbox.create failures itself — the threaded
    // scrubErrorDetail must redact stored values at the source (#3413 P1).
    const scrub = (createCalls[0].access as { scrubErrorDetail?: (d: string) => string })
      .scrubErrorDetail;
    expect(scrub).toBeDefined();
    expect(scrub!("401: token vc_tok rejected")).not.toContain("vc_tok");
  });

  it("throws an incompatible-version error when the factory returns a shapeless plugin", async () => {
    let thrown: unknown;
    try {
      await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
        getCredential: async () => makeCredential("e2b", { apiKey: "k" }),
        load: fakeLoader({
          "@useatlas/e2b": { e2bSandboxPlugin: () => ({ notASandbox: true }) },
          e2b: {},
        }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Misreporting this as a credentials problem would send the admin to the
    // wrong fix — the cause names the real (deployment) issue.
    expect(((thrown as Error).cause as Error).message).toMatch(
      /without sandbox\.create\(\).*incompatible plugin version/,
    );
  });

  it("throws (fail-closed) without echoing the provider error into the message", async () => {
    const mod = {
      e2bSandboxPlugin: () => ({
        sandbox: {
          create: async () => {
            // Provider SDK errors can echo the rejected key — the thrown
            // message becomes agent tool output, so it must stay generic.
            throw new Error("Unauthorized: API key 'e2b_sk_secret' is invalid");
          },
        },
      }),
    };
    let thrown: unknown;
    try {
      await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
        getCredential: async () => makeCredential("e2b", { apiKey: "e2b_sk_secret" }),
        load: fakeLoader({ "@useatlas/e2b": mod, e2b: {} }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("connected e2b sandbox failed to start");
    expect(message).not.toContain("e2b_sk_secret");
    // The detail stays on `cause` for operator-side diagnosis
    expect(((thrown as Error).cause as Error).message).toContain("Unauthorized");
  });

  it("throws when an installed plugin lacks the expected factory export", async () => {
    let thrown: unknown;
    try {
      await tryCreateByocBackend("org-1", "e2b-sandbox", SEMANTIC_ROOT, {
        getCredential: async () => makeCredential("e2b", { apiKey: "k" }),
        load: fakeLoader({ "@useatlas/e2b": { somethingElse: 1 }, e2b: {} }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Generic message to the agent; the incompatibility detail rides on cause
    expect((thrown as Error).message).toContain("connected e2b sandbox failed to start");
    expect(((thrown as Error).cause as Error).message).toMatch(
      /does not export e2bSandboxPlugin/,
    );
  });
});

// ---------------------------------------------------------------------------
// Python (#3410)
// ---------------------------------------------------------------------------

describe("providerSupportsPython", () => {
  it("covers vercel plus the plugin providers that ship a Python surface", () => {
    expect(providerSupportsPython("vercel")).toBe(true);
    expect(providerSupportsPython("e2b")).toBe(true);
    expect(providerSupportsPython("daytona")).toBe(true);
  });

  it("railway stays explore-only — its egress question is unresolved (#3414)", () => {
    // Not an oversight to tidy up: the railway plugin cannot block outbound
    // traffic, which interacts with the per-request allowlist semantics. If
    // this flips, that decision was made somewhere — not here.
    expect(providerSupportsPython("railway")).toBe(false);
  });
});

/** Fake in-tree python-sandbox module whose factory records its options. */
function fakePythonSandboxModule(
  execResult: { success: boolean; error?: string } = { success: true },
) {
  const factoryCalls: PythonSandboxOptions[] = [];
  const mod = {
    createPythonSandboxBackend: (options: PythonSandboxOptions = {}) => {
      factoryCalls.push(options);
      return {
        exec: async () => execResult,
      };
    },
  };
  return { mod, factoryCalls };
}

const VERCEL_TRIPLE = {
  accessToken: "vc_org_token",
  teamId: "team_1",
  projectId: "prj_1",
};

/** Default options thunk for calls that don't exercise the egress policy. */
const NO_OPTIONS = async () => ({});

describe("tryCreateByocPythonBackend — not engaged (falls through to operator chain)", () => {
  it("returns null for non-BYOC backend ids without touching credentials", async () => {
    let credentialReads = 0;
    const backend = await tryCreateByocPythonBackend("org-1", "sidecar", NO_OPTIONS, {
      getCredential: async () => {
        credentialReads++;
        return null;
      },
      load: fakeLoader({}),
    });
    expect(backend).toBeNull();
    expect(credentialReads).toBe(0);
  });

  it("returns null for python-incapable providers without touching credentials", async () => {
    // The org's railway selection covers explore only — python falls through
    // to the operator chain, and the capability gate short-circuits before any
    // credential read. (e2b and daytona left this class in #4665; railway is
    // what remains, deliberately.)
    let credentialReads = 0;
    const backend = await tryCreateByocPythonBackend("org-1", "railway-sandbox", NO_OPTIONS, {
      getCredential: async () => {
        credentialReads++;
        return makeCredential("railway", { token: "t", environmentId: "e" });
      },
      load: fakeLoader({ "@useatlas/railway-sandbox": {}, railway: {} }),
    });
    expect(backend).toBeNull();
    expect(credentialReads).toBe(0);
  });

  it("returns null when the org has no stored vercel credentials", async () => {
    const backend = await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
      getCredential: async () => null,
      load: fakeLoader({ "@vercel/sandbox": {} }),
    });
    expect(backend).toBeNull();
  });

  it("returns null when stored credentials miss runtime-required fields", async () => {
    const backend = await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
      getCredential: async () =>
        makeCredential("vercel", { accessToken: "tok", teamId: "team_1" }),
      load: fakeLoader({ "@vercel/sandbox": {} }),
    });
    expect(backend).toBeNull();
  });

  it("returns null when @vercel/sandbox is not installed", async () => {
    const backend = await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
      getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
      load: fakeLoader({}),
    });
    expect(backend).toBeNull();
  });

  it("fails closed (throws) when the runtime is installed but fails to load", async () => {
    const brokenLoader: ModuleLoader = async () => {
      throw new Error("init failed under resource pressure"); // no not-found code
    };
    let thrown: unknown;
    try {
      await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
        getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
        load: brokenLoader,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("runtime failed to load");
  });

  it("does not invoke the options thunk unless engaged", async () => {
    // The thunk fronts a per-request datasource resolve (#2927) — a
    // selected-but-unusable override must not pay that I/O.
    let optionReads = 0;
    const countingOptions = async () => {
      optionReads++;
      return {};
    };
    // Not engaged: incomplete credentials
    await tryCreateByocPythonBackend("org-1", "vercel-sandbox", countingOptions, {
      getCredential: async () =>
        makeCredential("vercel", { accessToken: "tok", teamId: "team_1" }),
      load: fakeLoader({ "@vercel/sandbox": {} }),
    });
    // Not engaged: python-incapable provider (railway — e2b and daytona now
    // declare a Python surface, #4665)
    await tryCreateByocPythonBackend("org-1", "railway-sandbox", countingOptions, {
      getCredential: async () =>
        makeCredential("railway", { token: "t", environmentId: "e" }),
      load: fakeLoader({ "@useatlas/railway-sandbox": {}, railway: {} }),
    });
    expect(optionReads).toBe(0);

    // Engaged: thunk runs exactly once
    const { mod } = fakePythonSandboxModule();
    await tryCreateByocPythonBackend("org-1", "vercel-sandbox", countingOptions, {
      getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
      load: fakeLoader({
        "@vercel/sandbox": {},
        "@atlas/api/lib/tools/python-sandbox": mod,
      }),
    });
    expect(optionReads).toBe(1);
  });
});

describe("tryCreateByocPythonBackend — engaged", () => {
  it("constructs the python sandbox with the stored triple as an access override", async () => {
    const { mod, factoryCalls } = fakePythonSandboxModule();
    const backend = await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
      getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
      load: fakeLoader({
        "@vercel/sandbox": {},
        "@atlas/api/lib/tools/python-sandbox": mod,
      }),
    });
    expect(backend).not.toBeNull();
    expect(factoryCalls.length).toBe(1);
    const access = factoryCalls[0].access!;
    expect(access.teamId).toBe("team_1");
    expect(access.projectId).toBe("prj_1");
    // RedactedSecret-branded: revealable at the create site, but an
    // accidental structured log of the options leaks nothing.
    expect(access.token.reveal()).toBe("vc_org_token");
    expect(JSON.stringify(factoryCalls[0])).not.toContain("vc_org_token");
    // The backend logs provider errors before the wrapper's result scrub —
    // the threaded scrubErrorDetail must redact stored values at the source
    // (#3413 P1).
    expect(factoryCalls[0].scrubErrorDetail).toBeDefined();
    expect(
      factoryCalls[0].scrubErrorDetail!("401: token vc_org_token rejected"),
    ).not.toContain("vc_org_token");
    const result = await backend!.exec("print(1)");
    expect(result.success).toBe(true);
  });

  it("threads the caller's per-request network policy through to the sandbox options", async () => {
    const { mod, factoryCalls } = fakePythonSandboxModule();
    const networkPolicy = { allow: { "api.example.com": {} } } as never;
    await tryCreateByocPythonBackend(
      "org-1",
      "vercel-sandbox",
      async () => ({ networkPolicy }),
      {
        getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
        load: fakeLoader({
          "@vercel/sandbox": {},
          "@atlas/api/lib/tools/python-sandbox": mod,
        }),
      },
    );
    expect(factoryCalls[0].networkPolicy).toBe(networkPolicy);
  });

  it("scrubs stored credential values from failed exec results", async () => {
    // The lazy backend maps provider failures to result objects (not throws),
    // so the error text the agent sees must be scrubbed against the org's
    // stored values — a Sandbox.create failure can echo the rejected token.
    const { mod } = fakePythonSandboxModule({
      success: false,
      error: "Failed to create Python Vercel Sandbox: token vc_org_token rejected.",
    });
    const backend = await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
      getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
      load: fakeLoader({
        "@vercel/sandbox": {},
        "@atlas/api/lib/tools/python-sandbox": mod,
      }),
    });
    const result = await backend!.exec("print(1)");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("vc_org_token");
      expect(result.error).toContain("[REDACTED]");
    }
  });

  it("throws a generic credential-scrubbed error when construction itself fails", async () => {
    const brokenModule = {
      createPythonSandboxBackend: () => {
        throw new Error("factory exploded with token vc_org_token");
      },
    };
    let thrown: unknown;
    try {
      await tryCreateByocPythonBackend("org-1", "vercel-sandbox", NO_OPTIONS, {
        getCredential: async () => makeCredential("vercel", VERCEL_TRIPLE),
        load: fakeLoader({
          "@vercel/sandbox": {},
          "@atlas/api/lib/tools/python-sandbox": brokenModule,
        }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("connected vercel sandbox failed to start");
    expect(message).not.toContain("vc_org_token");
    // The detail stays on `cause` for operator-side diagnosis
    expect(((thrown as Error).cause as Error).message).toContain("factory exploded");
  });
});

// ---------------------------------------------------------------------------
// Plugin-provided Python backends (#3414 contract, #4665 providers)
// ---------------------------------------------------------------------------

interface FakePluginPythonOptions {
  wrapperSource: string;
  timeoutMs: number;
  maxOutputBytes: number;
  networkPolicy?: { mode: string; hosts?: readonly string[] };
  scrubErrorDetail?: (detail: string) => string;
}

/**
 * A plugin module whose sandbox declares the Python surface. Records the
 * options it was handed and the (code, data) it was executed with, so a test
 * can assert on the contract the host promises plugins rather than only on the
 * result that came back.
 */
function fakePythonPluginModule(
  factoryExport: string,
  // `unknown` covers the function case too — narrowed with a typeof check
  // below. Spelling the union out widens to `any` under type-aware lint.
  execResult: unknown,
  egressControl?: "enforced" | "unsupported",
) {
  const optionCalls: FakePluginPythonOptions[] = [];
  const execCalls: { code: string; data: unknown }[] = [];
  let closes = 0;
  const mod = {
    [factoryExport]: (_config: Record<string, unknown>) => ({
      sandbox: {
        create: async () => ({
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
        createPython: (options: FakePluginPythonOptions) => {
          optionCalls.push(options);
          return {
            exec: async (code: string, data: unknown) => {
              execCalls.push({ code, data });
              return typeof execResult === "function"
                ? (execResult as (c: string, d: unknown) => unknown)(code, data)
                : execResult;
            },
            close: async () => {
              closes++;
            },
          };
        },
        ...(egressControl ? { pythonEgressControl: egressControl } : {}),
      },
    }),
  };
  return { mod, optionCalls, execCalls, closes: () => closes };
}

const E2B_CREDS = { apiKey: "e2b_org_key_abcdef" };

/** Deps that serve one provider's credentials and one loader map. */
function pluginDeps(
  provider: "e2b" | "daytona",
  credentials: Record<string, unknown>,
  modules: Record<string, unknown>,
) {
  return {
    getCredential: async () => makeCredential(provider, credentials),
    load: fakeLoader(modules),
  };
}

describe("tryCreateByocPythonBackend — plugin providers", () => {
  it("runs Python on the org's plugin backend and round-trips data (#4665)", async () => {
    const { mod, execCalls } = fakePythonPluginModule(
      "e2bSandboxPlugin",
      (code: string, data: unknown) => ({
        success: true,
        output: `ran ${code} over ${JSON.stringify(data)}`,
      }),
    );
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    expect(backend).not.toBeNull();

    const data = { columns: ["n"], rows: [[1], [2]] };
    const result = await backend!.exec("print(df)", data);

    // The data payload reached the plugin unchanged, and the result came back
    // structured — the round trip the residency claim rests on.
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.data).toEqual(data);
    expect(result.success).toBe(true);
    expect(result.success && result.output).toContain('{"columns":["n"],"rows":[[1],[2]]}');
  });

  it("hands the plugin the host's wrapper, timeout and output cap", async () => {
    const { mod, optionCalls } = fakePythonPluginModule("daytonaSandboxPlugin", {
      success: true,
    });
    await tryCreateByocPythonBackend(
      "org-1",
      "daytona-sandbox",
      async () => ({}),
      pluginDeps("daytona", { apiKey: "dt_org_key_abcdef" }, {
        "@useatlas/daytona": mod,
        "@daytonaio/sdk": {},
      }),
    );
    expect(optionCalls).toHaveLength(1);
    const options = optionCalls[0]!;
    // The wrapper is the host's, so every provider runs the same in-sandbox
    // import guard — a plugin shipping its own copy is what this prevents.
    expect(options.wrapperSource).toContain("_BLOCKED_MODULES");
    expect(options.wrapperSource).toContain("ATLAS_RESULT_FILE");
    // Timeout parity with the reference backend, set by the host.
    expect(options.timeoutMs).toBe(30_000);
    expect(options.maxOutputBytes).toBe(1024 * 1024);
  });

  it("normalises the egress allowlist into the provider-neutral shape", async () => {
    const { mod, optionCalls } = fakePythonPluginModule("e2bSandboxPlugin", {
      success: true,
    });
    await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      // Built by the real constructor, not a hand-shaped literal: this asserts
      // the normaliser handles what the host actually produces (#2927).
      async () => ({
        networkPolicy: networkPolicyFromAllowlist(["crm.example.com"]),
      }),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    expect(optionCalls[0]!.networkPolicy).toEqual({
      mode: "allowlist",
      hosts: ["crm.example.com"],
    });
  });

  it("defaults an unset policy to deny-all, never allow-all", async () => {
    const { mod, optionCalls } = fakePythonPluginModule("e2bSandboxPlugin", {
      success: true,
    });
    await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    expect(optionCalls[0]!.networkPolicy).toEqual({ mode: "deny-all" });
  });

  it("FAILS CLOSED when the installed plugin has no Python surface", async () => {
    // The one way host and plugin can disagree: capability is declared by the
    // runtime table, so an older installed package must raise rather than let
    // the org's Python fall through to the operator's US account. This is the
    // criterion #4665 exists for — a happy-path test cannot distinguish a
    // working implementation from the fall-through it replaced.
    const { mod } = fakePluginModule("e2bSandboxPlugin", "explore-only");
    await expect(
      tryCreateByocPythonBackend(
        "org-1",
        "e2b-sandbox",
        async () => ({}),
        pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
      ),
    ).rejects.toThrow(/failed to start/i);
  });

  it("FAILS CLOSED on revoked credentials rather than using the operator chain", async () => {
    const mod = {
      e2bSandboxPlugin: () => ({
        sandbox: {
          create: async () => ({ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
          createPython: () => {
            throw new Error("401 Unauthorized: invalid api key e2b_org_key_abcdef");
          },
        },
      }),
    };
    const call = tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    await expect(call).rejects.toThrow(/failed to start/i);
    // Credential-scrubbing parity: the agent-visible message must not carry the
    // rejected key the provider echoed back.
    await call.catch((err: unknown) => {
      expect(err instanceof Error ? err.message : "").not.toContain("e2b_org_key_abcdef");
    });
  });

  it("scrubs stored credential values out of plugin failure results", async () => {
    const { mod } = fakePythonPluginModule("e2bSandboxPlugin", {
      success: false,
      error: "sandbox rejected key e2b_org_key_abcdef",
    });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    const result = await backend!.exec("print(1)");
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).not.toContain("e2b_org_key_abcdef");
    expect(result.success === false && result.error).toContain("[REDACTED]");
  });

  it("enforces the 1 MB cap at the seam even when the plugin ignores it", async () => {
    const { mod } = fakePythonPluginModule("e2bSandboxPlugin", {
      success: true,
      output: "x".repeat(1024 * 1024 + 10),
    });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    const result = await backend!.exec("print('x' * 2000000)");
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("exceeded 1 MB limit");
  });

  it("counts base64 charts against the cap, not just the result payload", async () => {
    const { mod } = fakePythonPluginModule("e2bSandboxPlugin", {
      success: true,
      output: "small",
      charts: [{ base64: "A".repeat(1024 * 1024 + 10), mimeType: "image/png" }],
    });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    const result = await backend!.exec("chart_path()");
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("exceeded 1 MB limit");
  });

  it("turns a malformed plugin result into a named failure, never a silent success", async () => {
    const { mod } = fakePythonPluginModule("e2bSandboxPlugin", "not an object");
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    const result = await backend!.exec("print(1)");
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("@useatlas/e2b");
    expect(result.success === false && result.error).toContain("plugin defect");
  });

  it("drops chart entries that carry no base64 rather than passing them on", async () => {
    const { mod } = fakePythonPluginModule("e2bSandboxPlugin", {
      success: true,
      charts: [{ base64: "abc", mimeType: "image/png" }, { mimeType: "image/png" }, null],
    });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    const result = await backend!.exec("chart_path()");
    expect(result.success).toBe(true);
    expect(result.success && result.charts).toEqual([
      { base64: "abc", mimeType: "image/png" },
    ]);
  });

  it("releases the per-request sandbox after the run, so it cannot linger on the org's account", async () => {
    // BYOC Python backends are built fresh per request and exec'd once, so
    // nothing will ever reuse this sandbox — leaving it running bills the org
    // for an idle VM until their provider's reaper gets to it.
    const fake = fakePythonPluginModule("e2bSandboxPlugin", { success: true });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": fake.mod, e2b: {} }),
    );
    await backend!.exec("print(1)");
    expect(fake.closes()).toBe(1);
  });

  it("still returns the result when releasing the sandbox fails", async () => {
    // The result is already in hand; a teardown fault must not turn a
    // successful run into an error the agent has to retry.
    const mod = {
      e2bSandboxPlugin: () => ({
        sandbox: {
          create: async () => ({ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
          createPython: () => ({
            exec: async () => ({ success: true, output: "42" }),
            close: async () => {
              throw new Error("provider refused to release the sandbox");
            },
          }),
        },
      }),
    };
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({}),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": mod, e2b: {} }),
    );
    const result = await backend!.exec("print(42)");
    expect(result).toEqual({ success: true, output: "42" });
  });

  it("reads the egress posture from the PLUGIN, not from a host-side table", async () => {
    // The plugin is the only thing that knows whether it applied the policy.
    // A provider that gains real enforcement and declares it must stop being
    // reported as unenforced without anyone editing the host.
    const enforced = fakePythonPluginModule(
      "e2bSandboxPlugin",
      { success: true },
      "enforced",
    );
    const unsupported = fakePythonPluginModule(
      "daytonaSandboxPlugin",
      { success: true },
      "unsupported",
    );

    // Both must construct and run; the declaration changes only what is logged
    // about the bound, never whether the org's own account is used.
    for (const [backendId, provider, fake, creds] of [
      ["e2b-sandbox", "e2b", enforced, E2B_CREDS],
      ["daytona-sandbox", "daytona", unsupported, { apiKey: "dt_org_key_abcdef" }],
    ] as const) {
      const modules =
        provider === "e2b"
          ? { "@useatlas/e2b": fake.mod, e2b: {} }
          : { "@useatlas/daytona": fake.mod, "@daytonaio/sdk": {} };
      const backend = await tryCreateByocPythonBackend(
        backendId,
        backendId,
        async () => ({ networkPolicy: networkPolicyFromAllowlist(["crm.example.com"]) }),
        pluginDeps(provider, creds, modules),
      );
      expect(backend).not.toBeNull();
      expect(await backend!.exec("print(1)")).toEqual({ success: true });
    }
  });

  it("treats an absent egress declaration as unsupported, never as enforced", async () => {
    // Omission must not read as a bound being applied — the honest default is
    // to assume there is none.
    const fake = fakePythonPluginModule("e2bSandboxPlugin", { success: true });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "e2b-sandbox",
      async () => ({ networkPolicy: networkPolicyFromAllowlist(["crm.example.com"]) }),
      pluginDeps("e2b", E2B_CREDS, { "@useatlas/e2b": fake.mod, e2b: {} }),
    );
    // The policy still reaches the plugin — it is told what was asked for even
    // when it cannot apply it — and the host logs the gap.
    expect(fake.optionCalls[0]!.networkPolicy).toEqual({
      mode: "allowlist",
      hosts: ["crm.example.com"],
    });
    expect(await backend!.exec("print(1)")).toEqual({ success: true });
  });

  it("stays NOT ENGAGED for railway, which declares no Python surface", async () => {
    const { mod } = fakePythonPluginModule("railwaySandboxPlugin", { success: true });
    const backend = await tryCreateByocPythonBackend(
      "org-1",
      "railway-sandbox",
      async () => ({}),
      pluginDeps("e2b", { token: "t", environmentId: "e" }, {
        "@useatlas/railway-sandbox": mod,
        railway: {},
      }),
    );
    // Not engaged → null → the caller uses the operator chain, which is the
    // documented behaviour for a provider without Python support.
    expect(backend).toBeNull();
  });
});
