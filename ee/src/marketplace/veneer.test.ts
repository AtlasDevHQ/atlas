/**
 * Plugin-marketplace plan-gated veneer (EE) test — #4001 (WS5).
 *
 * `makeMarketplaceVeneerLive().isSaasIneligible` is the SaaS-eligibility gate
 * the marketplace listing filter + install gate consult. It must gate a row
 * iff the resolved deploy mode is `"saas"` AND the row is explicitly
 * `saas_eligible === false`. Self-hosted (or an absent/null flag) is always
 * eligible — that's the unchanged self-hosted behavior the Noop default
 * mirrors in core.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mutable deploy mode for the config mock ─────────────────────────
let mockDeployMode: "saas" | "self-hosted" | undefined;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => (mockDeployMode ? { deployMode: mockDeployMode } : null),
}));

const { makeMarketplaceVeneerLive } = await import("./veneer");

describe("MarketplaceVeneerLive — isSaasIneligible", () => {
  beforeEach(() => {
    mockDeployMode = undefined;
  });

  it("gates an explicit saas_eligible=false row on a SaaS deploy", () => {
    mockDeployMode = "saas";
    const veneer = makeMarketplaceVeneerLive();
    expect(veneer.isSaasIneligible({ saas_eligible: false })).toBe(true);
  });

  it("does NOT gate a saas_eligible=true row on a SaaS deploy", () => {
    mockDeployMode = "saas";
    const veneer = makeMarketplaceVeneerLive();
    expect(veneer.isSaasIneligible({ saas_eligible: true })).toBe(false);
  });

  it("does NOT gate a saas_eligible=false row on a self-hosted deploy", () => {
    mockDeployMode = "self-hosted";
    const veneer = makeMarketplaceVeneerLive();
    expect(veneer.isSaasIneligible({ saas_eligible: false })).toBe(false);
  });

  it("does NOT gate a saas_eligible=false row when deploy mode is unresolved", () => {
    // getConfig() → null → deployMode undefined → treated as not-SaaS.
    mockDeployMode = undefined;
    const veneer = makeMarketplaceVeneerLive();
    expect(veneer.isSaasIneligible({ saas_eligible: false })).toBe(false);
  });

  it("treats an absent saas_eligible flag as eligible even on SaaS (only explicit false gates)", () => {
    mockDeployMode = "saas";
    const veneer = makeMarketplaceVeneerLive();
    expect(veneer.isSaasIneligible({})).toBe(false);
  });

  it("treats a null saas_eligible flag as eligible even on SaaS", () => {
    mockDeployMode = "saas";
    const veneer = makeMarketplaceVeneerLive();
    expect(veneer.isSaasIneligible({ saas_eligible: null })).toBe(false);
  });

  it("re-reads the resolved deploy mode on every call (no cached config)", () => {
    const veneer = makeMarketplaceVeneerLive();
    mockDeployMode = "self-hosted";
    expect(veneer.isSaasIneligible({ saas_eligible: false })).toBe(false);
    mockDeployMode = "saas";
    expect(veneer.isSaasIneligible({ saas_eligible: false })).toBe(true);
  });
});
