import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Import after mocks
const {
  getWorkspaceBranding,
  getWorkspaceBrandingPublic,
  setWorkspaceBranding,
  deleteWorkspaceBranding,
  BrandingError,
} = await import("./white-label");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "brand-123",
    org_id: "org-1",
    logo_url: "https://example.com/logo.png",
    logo_text: "Acme Corp",
    primary_color: "#FF5500",
    favicon_url: "https://example.com/favicon.ico",
    hide_atlas_branding: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("getWorkspaceBranding", () => {
  beforeEach(() => ee.reset());

  it("returns branding when found", async () => {
    ee.queueMockRows([makeRow()]);
    const result = await run(getWorkspaceBranding("org-1"));
    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-1");
    expect(result!.logoUrl).toBe("https://example.com/logo.png");
    expect(result!.logoText).toBe("Acme Corp");
    expect(result!.primaryColor).toBe("#FF5500");
    expect(result!.hideAtlasBranding).toBe(true);
  });

  it("returns null when no branding found", async () => {
    ee.queueMockRows([]);
    const result = await run(getWorkspaceBranding("org-1"));
    expect(result).toBeNull();
  });

  it("fails when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(getWorkspaceBranding("org-1"))).rejects.toThrow("Enterprise features");
  });

  it("returns null when no internal DB", async () => {
    ee.setHasInternalDB(false);
    const result = await run(getWorkspaceBranding("org-1"));
    expect(result).toBeNull();
    expect(ee.capturedQueries.length).toBe(0);
  });
});

describe("getWorkspaceBrandingPublic", () => {
  beforeEach(() => ee.reset());

  it("returns branding without enterprise check", async () => {
    ee.setEnterpriseEnabled(false);
    ee.queueMockRows([makeRow()]);
    const result = await run(getWorkspaceBrandingPublic("org-1"));
    expect(result).not.toBeNull();
    expect(result!.logoText).toBe("Acme Corp");
  });

  it("returns null when no branding found", async () => {
    ee.queueMockRows([]);
    const result = await run(getWorkspaceBrandingPublic("org-1"));
    expect(result).toBeNull();
  });

  it("returns null when no internal DB", async () => {
    ee.setHasInternalDB(false);
    const result = await run(getWorkspaceBrandingPublic("org-1"));
    expect(result).toBeNull();
    expect(ee.capturedQueries.length).toBe(0);
  });
});

describe("setWorkspaceBranding", () => {
  beforeEach(() => ee.reset());

  it("upserts branding and returns result", async () => {
    ee.queueMockRows([makeRow()]);
    const result = await run(setWorkspaceBranding("org-1", {
      logoUrl: "https://example.com/logo.png",
      logoText: "Acme Corp",
      primaryColor: "#FF5500",
      faviconUrl: "https://example.com/favicon.ico",
      hideAtlasBranding: true,
    }));
    expect(result.orgId).toBe("org-1");
    expect(result.logoUrl).toBe("https://example.com/logo.png");
    expect(ee.capturedQueries[0].sql).toContain("INSERT INTO workspace_branding");
  });

  it("fails on invalid hex color", async () => {
    await expect(
      run(setWorkspaceBranding("org-1", { primaryColor: "not-a-color" })),
    ).rejects.toThrow("Invalid primary color");
  });

  it("rejects 3-digit hex shorthand", async () => {
    await expect(
      run(setWorkspaceBranding("org-1", { primaryColor: "#F50" })),
    ).rejects.toThrow("Invalid primary color");
  });

  it("rejects 8-digit hex with alpha", async () => {
    await expect(
      run(setWorkspaceBranding("org-1", { primaryColor: "#FF550080" })),
    ).rejects.toThrow("Invalid primary color");
  });

  it("fails on invalid logo URL", async () => {
    await expect(
      run(setWorkspaceBranding("org-1", { logoUrl: "not-a-url" })),
    ).rejects.toThrow("Invalid logo URL");
  });

  it("fails on javascript: logo URL (XSS prevention)", async () => {
    await expect(
      run(setWorkspaceBranding("org-1", { logoUrl: "javascript:alert(1)" })),
    ).rejects.toThrow("Logo URL must use http:// or https://");
  });

  it("fails on invalid favicon URL", async () => {
    await expect(
      run(setWorkspaceBranding("org-1", { faviconUrl: "ftp://bad" })),
    ).rejects.toThrow("Favicon URL must use http");
  });

  it("allows empty string values (treated as null)", async () => {
    ee.queueMockRows([makeRow({ logo_url: null, primary_color: null, favicon_url: null })]);
    const result = await run(setWorkspaceBranding("org-1", {
      logoUrl: "",
      primaryColor: "",
      faviconUrl: "",
    }));
    expect(result).not.toBeNull();
  });

  it("allows null/empty values", async () => {
    ee.queueMockRows([makeRow({ logo_url: null, logo_text: null, primary_color: null, favicon_url: null, hide_atlas_branding: false })]);
    const result = await run(setWorkspaceBranding("org-1", {
      logoUrl: null,
      logoText: null,
      primaryColor: null,
      faviconUrl: null,
      hideAtlasBranding: false,
    }));
    expect(result.logoUrl).toBeNull();
    expect(result.hideAtlasBranding).toBe(false);
  });

  it("fails when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(
      run(setWorkspaceBranding("org-1", { logoText: "Test" })),
    ).rejects.toThrow("Enterprise features");
  });

  it("fails when no internal DB", async () => {
    ee.setHasInternalDB(false);
    await expect(
      run(setWorkspaceBranding("org-1", { logoText: "Test" })),
    ).rejects.toThrow("Internal database required");
  });

  it("dies when INSERT returns no rows", async () => {
    ee.queueMockRows([]);
    await expect(
      run(setWorkspaceBranding("org-1", { logoText: "Test" })),
    ).rejects.toThrow("Failed to save workspace branding");
  });
});

describe("deleteWorkspaceBranding", () => {
  beforeEach(() => ee.reset());

  it("returns true when branding was deleted", async () => {
    ee.queueMockRows([{ id: "brand-123" }]);
    const result = await run(deleteWorkspaceBranding("org-1"));
    expect(result).toBe(true);
  });

  it("returns false when no branding existed", async () => {
    ee.queueMockRows([]);
    const result = await run(deleteWorkspaceBranding("org-1"));
    expect(result).toBe(false);
  });

  it("fails when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(deleteWorkspaceBranding("org-1"))).rejects.toThrow("Enterprise features");
  });

  it("fails when no internal DB", async () => {
    ee.setHasInternalDB(false);
    await expect(run(deleteWorkspaceBranding("org-1"))).rejects.toThrow("Internal database required");
  });
});

describe("BrandingError", () => {
  it("has correct name and code", () => {
    const err = new BrandingError("test error", "validation");
    expect(err.name).toBe("BrandingError");
    expect(err.code).toBe("validation");
    expect(err.message).toBe("test error");
  });
});
