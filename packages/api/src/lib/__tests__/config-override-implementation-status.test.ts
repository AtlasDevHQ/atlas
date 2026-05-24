/**
 * Tests for the `overrideImplementationStatus` config field (1.5.3 #2743).
 *
 * Inert in this slice — only the schema + ResolvedConfig + read helper
 * are wired. Slice 9 (#2747) adds the UI consumer.
 *
 * The hook lets a self-host operator promote a `coming_soon` catalog row
 * to `available` (e.g. they've shipped their own install handler) per
 * ADR-0007 §"Catalog seeding for Datasources".
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "path";

const configModPath = resolve(__dirname, "../config.ts");
const configMod = await import(`${configModPath}?t=${Date.now()}`);
const { validateAndResolve, getCatalogImplementationStatus, _resetConfig } =
  configMod as typeof import("../config");

describe("validateAndResolve — overrideImplementationStatus", () => {
  it("admits a slug → status map", () => {
    const resolved = validateAndResolve({
      overrideImplementationStatus: {
        discord: "available",
        teams: "coming_soon",
      },
    });
    expect(resolved.overrideImplementationStatus).toEqual({
      discord: "available",
      teams: "coming_soon",
    });
  });

  it("rejects unknown status values", () => {
    expect(() =>
      validateAndResolve({
        overrideImplementationStatus: { foo: "ga" },
      }),
    ).toThrow();
  });

  it("omits the field on the ResolvedConfig when no override is declared", () => {
    const resolved = validateAndResolve({});
    expect("overrideImplementationStatus" in resolved).toBe(false);
  });
});

describe("getCatalogImplementationStatus", () => {
  it("returns the override when set", () => {
    _resetConfig();
    const resolved = validateAndResolve({
      overrideImplementationStatus: { discord: "available" },
    });
    expect(getCatalogImplementationStatus("discord", resolved)).toBe(
      "available",
    );
  });

  it("returns undefined when no override is declared for the slug", () => {
    const resolved = validateAndResolve({
      overrideImplementationStatus: { discord: "available" },
    });
    expect(getCatalogImplementationStatus("teams", resolved)).toBeUndefined();
  });

  it("returns undefined when overrideImplementationStatus is absent", () => {
    const resolved = validateAndResolve({});
    expect(getCatalogImplementationStatus("discord", resolved)).toBeUndefined();
  });

  it("falls back to the module-level resolved config when no config is passed", () => {
    _resetConfig();
    expect(getCatalogImplementationStatus("discord")).toBeUndefined();
  });
});
