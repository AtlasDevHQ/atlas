/**
 * Tests for the BYOC sandbox runtime (#3370).
 *
 * Everything is exercised through the module's DI seams (`ByocDeps` /
 * injectable ModuleLoader) — no mock.module, no DB, no network.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { SandboxCredential } from "../credentials";
import {
  sandboxProviderForBackendId,
  missingCredentialFields,
  isProviderRuntimeAvailable,
  getProviderRuntimeAvailability,
  tryCreateByocBackend,
  _resetRuntimeAvailabilityCacheForTest,
  type ModuleLoader,
} from "../runtime";

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
