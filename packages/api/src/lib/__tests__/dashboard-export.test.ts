/**
 * dashboard export unit tests (#3211).
 *
 * Exercises `exportDashboard` — title resolution, the `dparams` forwarding,
 * partial-render propagation, the deterministic filename, and the failure
 * mapping — through the `_setExportRenderFn` seam, without touching Playwright.
 * The Playwright-backed render path is covered by the screenshot smoke spec.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  exportDashboard,
  buildExportFilename,
  serializeDparams,
  _setExportRenderFn,
  type ExportRenderArgs,
} from "../dashboard-screenshot";

// Stub getDashboard so we don't touch the internal DB.
let dashboardResult: { ok: true; data: unknown } | { ok: false; reason: "no_db" | "not_found" | "error" } = {
  ok: true,
  data: {
    id: "dash-1",
    title: "Revenue overview",
    description: null,
    updatedAt: "2026-06-04",
    cards: [],
  },
};

void mock.module("@atlas/api/lib/dashboards", () => ({
  getDashboard: mock(async () => dashboardResult),
  createDashboard: undefined as never,
  listDashboards: undefined as never,
  updateDashboard: undefined as never,
  deleteDashboard: undefined as never,
  addCard: undefined as never,
  updateCard: undefined as never,
  removeCard: undefined as never,
  refreshCard: undefined as never,
  getCard: undefined as never,
  shareDashboard: undefined as never,
  unshareDashboard: undefined as never,
  getShareStatus: undefined as never,
  getSharedDashboard: undefined as never,
  setRefreshSchedule: undefined as never,
  CardLayoutSchema: { safeParse: () => ({ success: false }) },
  TextCardLayoutSchema: { safeParse: () => ({ success: false }) },
  resolveCardConnectionId: undefined as never,
  NoGroupMembersError: class {},
}));

describe("exportDashboard", () => {
  let lastArgs: ExportRenderArgs | null = null;
  const FAKE_PDF = Buffer.from("%PDF-FAKE", "utf8");
  const FIXED_NOW = new Date("2026-06-04T12:30:45.000Z");

  beforeEach(() => {
    lastArgs = null;
    dashboardResult = {
      ok: true,
      data: { id: "dash-1", title: "Revenue overview", description: null, updatedAt: "2026-06-04", cards: [] },
    };
    _setExportRenderFn(async (args) => {
      lastArgs = args;
      return { bytes: FAKE_PDF, contentType: "application/pdf", partial: false };
    });
  });

  afterEach(() => {
    _setExportRenderFn(null);
  });

  it("returns the rendered bytes + a title/timestamp filename", async () => {
    const result = await exportDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
      format: "pdf",
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bytes.toString()).toBe("%PDF-FAKE");
    expect(result.contentType).toBe("application/pdf");
    expect(result.title).toBe("Revenue overview");
    expect(result.partial).toBe(false);
    // Slugified title + UTC stamp.
    expect(result.filename).toBe("revenue-overview-20260604-123045.pdf");
  });

  it("forwards the caller's parameter overrides + title to the renderer", async () => {
    await exportDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
      format: "png",
      parameters: { region: "us", min: 5, blank: null, empty: "" },
      now: FIXED_NOW,
    });
    expect(lastArgs).not.toBeNull();
    expect(lastArgs!.format).toBe("png");
    expect(lastArgs!.title).toBe("Revenue overview");
    // Null/empty entries are dropped by the renderer's dparams serializer, but
    // the raw override map is what reaches the render args.
    expect(lastArgs!.parameters).toEqual({ region: "us", min: 5, blank: null, empty: "" });
    expect(typeof lastArgs!.generatedAt).toBe("string");
  });

  it("threads the API origin + timeout budget to the renderer (cross-origin cookies + budget)", async () => {
    await exportDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
      format: "pdf",
      baseUrl: "https://app.useatlas.dev",
      apiBaseUrl: "https://api.useatlas.dev",
      timeoutMs: 30_000,
      now: FIXED_NOW,
    });
    expect(lastArgs).not.toBeNull();
    // apiBaseUrl reaches the renderer so the forwarded session cookie can be
    // seeded for the API host too (not just the web host).
    expect(lastArgs!.apiBaseUrl).toBe("https://api.useatlas.dev");
    expect(lastArgs!.baseUrl).toBe("https://app.useatlas.dev");
    // The overall budget is handed to the renderer so its staged waits can
    // self-bound and never starve the capture into a 504.
    expect(lastArgs!.timeoutMs).toBe(30_000);
  });

  it("propagates a partial render from the renderer", async () => {
    _setExportRenderFn(async () => ({ bytes: FAKE_PDF, contentType: "application/pdf", partial: true }));
    const result = await exportDashboard({
      dashboardId: "dash-1",
      userId: "user-1",
      orgId: "org-1",
      format: "pdf",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.partial).toBe(true);
  });

  it("rejects an override that fails its declared parameter type (invalid_parameters)", async () => {
    dashboardResult = {
      ok: true,
      data: {
        id: "dash-1",
        title: "Revenue overview",
        description: null,
        updatedAt: "2026-06-04",
        cards: [],
        parameters: [{ key: "since", label: "Since", type: "date" }],
      },
    };
    let rendered = false;
    _setExportRenderFn(async () => {
      rendered = true;
      return { bytes: FAKE_PDF, contentType: "application/pdf", partial: false };
    });
    const result = await exportDashboard({
      dashboardId: "dash-1",
      userId: "u",
      orgId: "o",
      format: "pdf",
      parameters: { since: "not-a-date" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("invalid_parameters");
    // Validation fails closed BEFORE the headless render is ever invoked.
    expect(rendered).toBe(false);
  });

  it("maps a not_found dashboard to dashboard_not_found", async () => {
    dashboardResult = { ok: false, reason: "not_found" };
    const result = await exportDashboard({ dashboardId: "missing", userId: "u", orgId: "o", format: "pdf" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("dashboard_not_found");
  });

  it("maps a no_db lookup to no_db", async () => {
    dashboardResult = { ok: false, reason: "no_db" };
    const result = await exportDashboard({ dashboardId: "x", userId: "u", orgId: "o", format: "pdf" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("no_db");
  });

  it("maps an unknown lookup failure to dashboard_unavailable (not a 404)", async () => {
    dashboardResult = { ok: false, reason: "error" };
    const result = await exportDashboard({ dashboardId: "x", userId: "u", orgId: "o", format: "pdf" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("dashboard_unavailable");
  });

  it("maps a missing browser to browser_unavailable", async () => {
    _setExportRenderFn(async () => {
      throw new Error("playwright_not_installed");
    });
    const result = await exportDashboard({ dashboardId: "dash-1", userId: "u", orgId: "o", format: "pdf" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("browser_unavailable");
  });

  it("maps an overrun render to export_timeout", async () => {
    _setExportRenderFn(
      () => new Promise((resolve) => setTimeout(() => resolve({ bytes: FAKE_PDF, contentType: "application/pdf", partial: false }), 50)),
    );
    const result = await exportDashboard({
      dashboardId: "dash-1",
      userId: "u",
      orgId: "o",
      format: "pdf",
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("export_timeout");
  });

  it("maps an unexpected render throw to render_failed", async () => {
    _setExportRenderFn(async () => {
      throw new Error("nav crashed");
    });
    const result = await exportDashboard({ dashboardId: "dash-1", userId: "u", orgId: "o", format: "pdf" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.reason).toBe("render_failed");
  });

  it("falls back to a 'dashboard' slug for an empty/blank title", () => {
    expect(buildExportFilename("", "png", FIXED_NOW)).toBe("dashboard-20260604-123045.png");
    expect(buildExportFilename("  ", "pdf", FIXED_NOW)).toBe("dashboard-20260604-123045.pdf");
    expect(buildExportFilename("Q2 / Sales — North!", "pdf", FIXED_NOW)).toBe("q2-sales-north-20260604-123045.pdf");
  });

  describe("serializeDparams (parameter forwarding)", () => {
    it("serializes a non-empty override map to a JSON string", () => {
      expect(serializeDparams({ region: "us", min: 5 })).toBe('{"region":"us","min":5}');
    });

    it("drops null + empty-string entries (mirrors the parameter bar)", () => {
      expect(serializeDparams({ region: "us", blank: null, empty: "" })).toBe('{"region":"us"}');
    });

    it("returns null when the map is null, empty, or fully cleaned away", () => {
      expect(serializeDparams(null)).toBeNull();
      expect(serializeDparams(undefined)).toBeNull();
      expect(serializeDparams({})).toBeNull();
      expect(serializeDparams({ blank: null, empty: "" })).toBeNull();
    });
  });
});
