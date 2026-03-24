import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
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
    const result = await getWorkspaceBranding("org-1");
    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-1");
    expect(result!.logoUrl).toBe("https://example.com/logo.png");
    expect(result!.logoText).toBe("Acme Corp");
    expect(result!.primaryColor).toBe("#FF5500");
    expect(result!.hideAtlasBranding).toBe(true);
  });

  it("returns null when no branding found", async () => {
    ee.queueMockRows([]);
    const result = await getWorkspaceBranding("org-1");
    expect(result).toBeNull();
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(getWorkspaceBranding("org-1")).rejects.toThrow("Enterprise features");
  });

  it("returns null when no internal DB", async () => {
    ee.setHasInternalDB(false);
    const result = await getWorkspaceBranding("org-1");
    expect(result).toBeNull();
    expect(ee.capturedQueries.length).toBe(0);
  });
});

describe("getWorkspaceBrandingPublic", () => {
  beforeEach(() => ee.reset());

  it("returns branding without enterprise check", async () => {
    ee.setEnterpriseEnabled(false);
    ee.queueMockRows([makeRow()]);
    const result = await getWorkspaceBrandingPublic("org-1");
    expect(result).not.toBeNull();
    expect(result!.logoText).toBe("Acme Corp");
  });

  it("returns null when no branding found", async () => {
    ee.queueMockRows([]);
    const result = await getWorkspaceBrandingPublic("org-1");
    expect(result).toBeNull();
  });

  it("returns null when no internal DB", async () => {
    ee.setHasInternalDB(false);
    const result = await getWorkspaceBrandingPublic("org-1");
    expect(result).toBeNull();
    expect(ee.capturedQueries.length).toBe(0);
  });
});

describe("setWorkspaceBranding", () => {
  beforeEach(() => ee.reset());

  it("upserts branding and returns result", async () => {
    ee.queueMockRows([makeRow()]);
    const result = await setWorkspaceBranding("org-1", {
      logoUrl: "https://example.com/logo.png",
      logoText: "Acme Corp",
      primaryColor: "#FF5500",
      faviconUrl: "https://example.com/favicon.ico",
      hideAtlasBranding: true,
    });
    expect(result.orgId).toBe("org-1");
    expect(result.logoUrl).toBe("https://example.com/logo.png");
    expect(ee.capturedQueries[0].sql).toContain("INSERT INTO workspace_branding");
  });

  it("throws on invalid hex color", async () => {
    await expect(
      setWorkspaceBranding("org-1", { primaryColor: "not-a-color" }),
    ).rejects.toThrow("Invalid primary color");
  });

  it("rejects 3-digit hex shorthand", async () => {
    await expect(
      setWorkspaceBranding("org-1", { primaryColor: "#F50" }),
    ).rejects.toThrow("Invalid primary color");
  });

  it("rejects 8-digit hex with alpha", async () => {
    await expect(
      setWorkspaceBranding("org-1", { primaryColor: "#FF550080" }),
    ).rejects.toThrow("Invalid primary color");
  });

  it("throws on invalid logo URL", async () => {
    await expect(
      setWorkspaceBranding("org-1", { logoUrl: "not-a-url" }),
    ).rejects.toThrow("Invalid logo URL");
  });

  it("throws on javascript: logo URL (XSS prevention)", async () => {
    await expect(
      setWorkspaceBranding("org-1", { logoUrl: "javascript:alert(1)" }),
    ).rejects.toThrow("Logo URL must use http:// or https://");
  });

  it("throws on invalid favicon URL", async () => {
    await expect(
      setWorkspaceBranding("org-1", { faviconUrl: "ftp://bad" }),
    ).rejects.toThrow("Favicon URL must use http");
  });

  it("allows empty string values (treated as null)", async () => {
    ee.queueMockRows([makeRow({ logo_url: null, primary_color: null, favicon_url: null })]);
    const result = await setWorkspaceBranding("org-1", {
      logoUrl: "",
      primaryColor: "",
      faviconUrl: "",
    });
    expect(result).not.toBeNull();
  });

  it("allows null/empty values", async () => {
    ee.queueMockRows([makeRow({ logo_url: null, logo_text: null, primary_color: null, favicon_url: null, hide_atlas_branding: false })]);
    const result = await setWorkspaceBranding("org-1", {
      logoUrl: null,
      logoText: null,
      primaryColor: null,
      faviconUrl: null,
      hideAtlasBranding: false,
    });
    expect(result.logoUrl).toBeNull();
    expect(result.hideAtlasBranding).toBe(false);
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(
      setWorkspaceBranding("org-1", { logoText: "Test" }),
    ).rejects.toThrow("Enterprise features");
  });

  it("throws when no internal DB", async () => {
    ee.setHasInternalDB(false);
    await expect(
      setWorkspaceBranding("org-1", { logoText: "Test" }),
    ).rejects.toThrow("Internal database required");
  });

  it("throws when INSERT returns no rows", async () => {
    ee.queueMockRows([]);
    await expect(
      setWorkspaceBranding("org-1", { logoText: "Test" }),
    ).rejects.toThrow("Failed to save workspace branding");
  });
});

describe("deleteWorkspaceBranding", () => {
  beforeEach(() => ee.reset());

  it("returns true when branding was deleted", async () => {
    ee.queueMockRows([{ id: "brand-123" }]);
    const result = await deleteWorkspaceBranding("org-1");
    expect(result).toBe(true);
  });

  it("returns false when no branding existed", async () => {
    ee.queueMockRows([]);
    const result = await deleteWorkspaceBranding("org-1");
    expect(result).toBe(false);
  });

  it("throws when enterprise is disabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(deleteWorkspaceBranding("org-1")).rejects.toThrow("Enterprise features");
  });

  it("throws when no internal DB", async () => {
    ee.setHasInternalDB(false);
    await expect(deleteWorkspaceBranding("org-1")).rejects.toThrow("Internal database required");
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
