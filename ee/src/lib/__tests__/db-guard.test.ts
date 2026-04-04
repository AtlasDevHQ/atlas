import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createEEMock } from "../../__mocks__/internal";

// ── Mock all exports (CLAUDE.md: mock every named export) ──────────
const ee = createEEMock();
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);

// Import after mock
const { requireInternalDB } = await import("../db-guard");

// ── Tests ──────────────────────────────────────────────────────────

describe("requireInternalDB", () => {
  beforeEach(() => {
    ee.reset();
    ee.setHasInternalDB(false);
  });

  it("throws plain Error with label when no internal DB", () => {
    expect(() => requireInternalDB("custom role management")).toThrow(
      "Internal database required for custom role management.",
    );
  });

  it("does not throw when internal DB is available", () => {
    ee.setHasInternalDB(true);
    expect(() => requireInternalDB("anything")).not.toThrow();
  });

  it("throws custom error via errorFactory when no internal DB", () => {
    class TestDomainError extends Error {
      constructor(
        message: string,
        public readonly code: string,
      ) {
        super(message);
        this.name = "TestDomainError";
      }
    }

    try {
      requireInternalDB(
        "data residency",
        () => new TestDomainError("DB required for residency.", "no_internal_db"),
      );
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TestDomainError);
      expect((err as TestDomainError).message).toBe("DB required for residency.");
      expect((err as TestDomainError).code).toBe("no_internal_db");
    }
  });

  it("ignores errorFactory when internal DB is available", () => {
    ee.setHasInternalDB(true);
    expect(() =>
      requireInternalDB("test", () => new Error("should not be thrown")),
    ).not.toThrow();
  });

  it("uses plain Error (not factory) when no factory provided", () => {
    try {
      requireInternalDB("SLA metrics");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // Should NOT be a subclass — just plain Error
      expect((err as Error).constructor).toBe(Error);
      expect((err as Error).message).toBe("Internal database required for SLA metrics.");
    }
  });
});
