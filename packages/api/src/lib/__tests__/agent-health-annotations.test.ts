/**
 * Tests for agent buildSystemParam health annotations in the multi-source section.
 *
 * When connections have health status, buildMultiSourceSection (called by
 * buildSystemParam) annotates unhealthy/degraded sources in the system prompt.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { ConnectionMetadata, HealthCheckResult } from "../db/connection";

// --- Mocks ---

const mockDBConnection = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};

// Stateful mock — tests push entries to simulate different connection states
const mockEntries: ConnectionMetadata[] = [];

function resetMockEntries() {
  mockEntries.length = 0;
}

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: (id: string) => {
      const entry = mockEntries.find((e) => e.id === id);
      return entry?.dbType ?? ("postgres" as const);
    },
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => mockEntries.map((e) => e.id),
    describe: () =>
      mockEntries.map((e) => ({
        id: e.id,
        dbType: e.dbType,
        description: e.description,
        ...(e.health ? { health: e.health } : {}),
      })),
    _reset: () => {
      mockEntries.length = 0;
    },
  },
  detectDBType: () => "postgres" as const,
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

const { buildSystemParam } = await import("@atlas/api/lib/agent");

// --- Helpers ---

function getContent(result: string | { content: string }): string {
  return typeof result === "string" ? result : result.content;
}

function makeHealthy(): HealthCheckResult {
  return { status: "healthy", latencyMs: 5, checkedAt: new Date() };
}

function makeDegraded(message?: string): HealthCheckResult {
  return {
    status: "degraded",
    latencyMs: 2000,
    message: message ?? "High latency",
    checkedAt: new Date(),
  };
}

function makeUnhealthy(message?: string): HealthCheckResult {
  return {
    status: "unhealthy",
    latencyMs: 5000,
    message: message ?? "Connection refused",
    checkedAt: new Date(),
  };
}

// --- Tests ---

describe("buildSystemParam health annotations", () => {
  beforeEach(() => {
    resetMockEntries();
  });

  test("unhealthy source is annotated with UNAVAILABLE", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres", health: makeHealthy() },
      { id: "warehouse", dbType: "postgres", health: makeUnhealthy() },
    );

    const content = getContent(buildSystemParam("openai"));

    expect(content).toContain("UNAVAILABLE");
    expect(content).toContain("warehouse");
    expect(content).toContain("skip queries to this source");
  });

  test("degraded source is annotated with 'currently degraded'", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres", health: makeHealthy() },
      { id: "warehouse", dbType: "postgres", health: makeDegraded() },
    );

    const content = getContent(buildSystemParam("openai"));

    expect(content).toContain("currently degraded");
    expect(content).toContain("queries may fail");
  });

  test("healthy source has no health annotation", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres", health: makeHealthy() },
      { id: "warehouse", dbType: "postgres", health: makeHealthy() },
    );

    const content = getContent(buildSystemParam("openai"));

    expect(content).toContain("**default** (PostgreSQL)");
    expect(content).toContain("**warehouse** (PostgreSQL)");
    expect(content).not.toContain("UNAVAILABLE");
    expect(content).not.toContain("currently degraded");
  });

  test("only the unhealthy source gets the UNAVAILABLE annotation, not healthy ones", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres", health: makeHealthy() },
      { id: "broken", dbType: "mysql", health: makeUnhealthy("Connection refused") },
    );

    const content = getContent(buildSystemParam("openai"));

    // The "broken" source should have the annotation
    expect(content).toContain("**broken** (MySQL)");
    expect(content).toContain("UNAVAILABLE");

    // The "default" line should NOT have the annotation
    const defaultLine = content.split("\n").find((l: string) => l.includes("**default**"));
    expect(defaultLine).toBeDefined();
    expect(defaultLine!).not.toContain("UNAVAILABLE");
    expect(defaultLine!).not.toContain("degraded");
  });

  test("source without health field has no annotation", () => {
    mockEntries.push(
      { id: "default", dbType: "postgres" },
      { id: "warehouse", dbType: "postgres" },
    );

    const content = getContent(buildSystemParam("openai"));

    expect(content).toContain("Available Data Sources");
    expect(content).not.toContain("UNAVAILABLE");
    expect(content).not.toContain("currently degraded");
  });
});
