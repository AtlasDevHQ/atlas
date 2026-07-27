import { describe, expect, test } from "bun:test";
import {
  SANDBOX_PROVIDER_KEYS,
  SANDBOX_PROVIDER_BACKEND_IDS,
  SandboxProviderKeySchema,
  SandboxConnectedProviderSchema,
  SandboxStatusSchema,
  normalizeSandboxBackendValue,
} from "../sandbox";

describe("SANDBOX_PROVIDER_BACKEND_IDS", () => {
  test("every provider key maps to a backend id", () => {
    for (const key of SANDBOX_PROVIDER_KEYS) {
      const backendId = SANDBOX_PROVIDER_BACKEND_IDS[key];
      expect(typeof backendId).toBe("string");
      expect(backendId.length).toBeGreaterThan(0);
    }
  });

  test("maps to the registered plugin ids", () => {
    expect(SANDBOX_PROVIDER_BACKEND_IDS).toEqual({
      vercel: "vercel-sandbox",
      e2b: "e2b-sandbox",
      daytona: "daytona-sandbox",
      railway: "railway-sandbox",
    });
  });

  test("no two providers share a backend id", () => {
    const ids = Object.values(SANDBOX_PROVIDER_BACKEND_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("normalizeSandboxBackendValue", () => {
  test("maps legacy provider keys to backend ids", () => {
    expect(normalizeSandboxBackendValue("vercel")).toBe("vercel-sandbox");
    expect(normalizeSandboxBackendValue("e2b")).toBe("e2b-sandbox");
    expect(normalizeSandboxBackendValue("daytona")).toBe("daytona-sandbox");
    expect(normalizeSandboxBackendValue("railway")).toBe("railway-sandbox");
  });

  test("is identity for backend ids", () => {
    for (const backendId of Object.values(SANDBOX_PROVIDER_BACKEND_IDS)) {
      expect(normalizeSandboxBackendValue(backendId)).toBe(backendId);
    }
  });

  test("is identity for built-in backend names", () => {
    for (const builtIn of ["vercel-sandbox", "nsjail", "sidecar", "just-bash"]) {
      expect(normalizeSandboxBackendValue(builtIn)).toBe(builtIn);
    }
  });

  test("is identity for unknown plugin ids", () => {
    expect(normalizeSandboxBackendValue("my-custom-sandbox")).toBe("my-custom-sandbox");
  });

  test("is idempotent", () => {
    for (const key of SANDBOX_PROVIDER_KEYS) {
      const once = normalizeSandboxBackendValue(key);
      expect(normalizeSandboxBackendValue(once)).toBe(once);
    }
  });
});

describe("SandboxProviderKeySchema", () => {
  test("accepts every provider key", () => {
    for (const key of SANDBOX_PROVIDER_KEYS) {
      expect(SandboxProviderKeySchema.safeParse(key).success).toBe(true);
    }
  });

  test("rejects backend ids (vocabularies must not blur)", () => {
    expect(SandboxProviderKeySchema.safeParse("e2b-sandbox").success).toBe(false);
    expect(SandboxProviderKeySchema.safeParse("sidecar").success).toBe(false);
  });
});

describe("SandboxStatusSchema", () => {
  const validStatus = {
    activeBackend: "e2b-sandbox",
    platformDefault: "vercel-sandbox",
    workspaceOverride: "e2b-sandbox",
    workspaceSidecarUrl: null,
    availableBackends: [
      {
        id: "vercel-sandbox",
        name: "Vercel Sandbox",
        type: "built-in" as const,
        available: true,
        description: "Firecracker microVM",
      },
      { id: "e2b-sandbox", name: "E2B", type: "plugin" as const, available: true },
    ],
    connectedProviders: [
      {
        provider: "e2b" as const,
        displayName: "Acme",
        connectedAt: "2026-06-01T00:00:00.000Z",
        validatedAt: null,
        isActive: true,
      },
    ],
  };

  test("parses a full status payload", () => {
    expect(SandboxStatusSchema.safeParse(validStatus).success).toBe(true);
  });

  test("a healthy payload carries no failClosed block", () => {
    // `failClosed` is optional rather than nullable precisely so the healthy
    // payload keeps its pre-#4837 shape — an older web bundle parsing a newer
    // API must not start failing on a working deployment. Note this pins the
    // SCHEMA's tolerance; that the route actually omits the key on a healthy
    // deployment is pinned server-side in
    // `packages/api/src/api/__tests__/admin-sandbox.test.ts`.
    const parsed = SandboxStatusSchema.parse(validStatus);
    expect(parsed.failClosed).toBeUndefined();
  });

  test("parses the fail-closed payload — null ids plus a remediation", () => {
    const parsed = SandboxStatusSchema.parse({
      ...validStatus,
      activeBackend: null,
      platformDefault: null,
      workspaceOverride: null,
      connectedProviders: [],
      failClosed: { remediation: "Explore tool: UNAVAILABLE — …" },
    });
    expect(parsed.activeBackend).toBeNull();
    expect(parsed.platformDefault).toBeNull();
    expect(parsed.failClosed?.remediation).toContain("UNAVAILABLE");
  });

  test("failClosed without a remediation key is rejected", () => {
    // The block exists to carry the operator's fix, so the KEY is required.
    //
    // An empty string is deliberately still accepted (`z.string()`, not
    // `.min(1)`): the web parses this schema client-side, so a stricter rule
    // could only ever fire in the browser — turning a server-side inconsistency
    // into a hard parse failure of the one page whose purpose is reporting the
    // outage. The page treats empty as absent and keeps the alarm up instead.
    expect(
      SandboxStatusSchema.safeParse({
        ...validStatus,
        activeBackend: null,
        platformDefault: null,
        failClosed: {},
      }).success,
    ).toBe(false);

    expect(
      SandboxStatusSchema.safeParse({
        ...validStatus,
        activeBackend: null,
        platformDefault: null,
        failClosed: { remediation: "" },
      }).success,
    ).toBe(true);
  });

  test("rejects a connected provider with a backend-id provider value", () => {
    const result = SandboxConnectedProviderSchema.safeParse({
      ...validStatus.connectedProviders[0],
      provider: "e2b-sandbox",
    });
    expect(result.success).toBe(false);
  });
});
