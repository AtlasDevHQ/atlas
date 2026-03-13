import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @google-cloud/bigquery
// ---------------------------------------------------------------------------

const mockCreateQueryJob = mock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (): Promise<any> =>
    Promise.resolve([
      {
        metadata: {
          statistics: { totalBytesProcessed: "5000000000" }, // 5 GB
        },
      },
    ]),
);

const mockQuery = mock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (): Promise<any> =>
    Promise.resolve([
      [{ count: 42 }],
      null,
      { schema: { fields: [{ name: "count", type: "INTEGER" }] } },
    ]),
);

const mockBigQuery = mock(() => ({
  createQueryJob: mockCreateQueryJob,
  query: mockQuery,
}));

mock.module("@google-cloud/bigquery", () => ({
  BigQuery: mockBigQuery,
}));

import { estimateQueryCost, formatBytes, _resetCachedClient } from "../src/cost-estimator";
import { buildBigQueryPlugin, bigqueryPlugin } from "../src/index";
import type { QueryHookContext, QueryHookMutation, PluginHookEntry } from "@useatlas/plugin-sdk";

beforeEach(() => {
  mockCreateQueryJob.mockClear();
  mockBigQuery.mockClear();
  mockQuery.mockClear();
  _resetCachedClient();

  // Re-stub default return values after clearing
  mockCreateQueryJob.mockImplementation(() =>
    Promise.resolve([
      {
        metadata: {
          statistics: { totalBytesProcessed: "5000000000" },
        },
      },
    ]),
  );
  mockQuery.mockImplementation(() =>
    Promise.resolve([
      [{ count: 42 }],
      null,
      { schema: { fields: [{ name: "count", type: "INTEGER" }] } },
    ]),
  );
  mockBigQuery.mockImplementation(() => ({
    createQueryJob: mockCreateQueryJob,
    query: mockQuery,
  }));
});

// ---------------------------------------------------------------------------
// estimateQueryCost
// ---------------------------------------------------------------------------

describe("estimateQueryCost", () => {
  test("returns bytes scanned and estimated cost", async () => {
    const result = await estimateQueryCost("SELECT * FROM events", {
      projectId: "my-project",
    });
    expect(result).not.toBeNull();
    expect(result!.bytesScanned).toBe(5_000_000_000);
    // 5 GB = 0.005 TB × $5 = $0.025
    expect(result!.estimatedCostUsd).toBeCloseTo(0.025);
  });

  test("passes dryRun: true to createQueryJob", async () => {
    await estimateQueryCost("SELECT 1", { projectId: "my-project" });
    expect(mockCreateQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, useLegacySql: false }),
    );
  });

  test("passes location and defaultDataset when configured", async () => {
    await estimateQueryCost("SELECT 1", {
      projectId: "my-project",
      dataset: "analytics",
      location: "US",
    });
    expect(mockCreateQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        location: "US",
        defaultDataset: { datasetId: "analytics", projectId: "my-project" },
      }),
    );
  });

  test("returns null when dry run fails", async () => {
    mockCreateQueryJob.mockImplementation(() =>
      Promise.reject(new Error("Permission denied")),
    );
    const result = await estimateQueryCost("SELECT * FROM secret_table", {
      projectId: "my-project",
    });
    expect(result).toBeNull();
  });

  test("returns null when BigQuery module is unavailable", async () => {
    // Temporarily break the require (module is already mocked, so this tests
    // the catch path by making createQueryJob return bad shape)
    mockBigQuery.mockImplementation(() => {
      throw new Error("MODULE_NOT_FOUND");
    });
    const result = await estimateQueryCost("SELECT 1", {});
    expect(result).toBeNull();
  });

  test("handles zero bytes scanned", async () => {
    mockCreateQueryJob.mockImplementation(() =>
      Promise.resolve([{ metadata: { statistics: { totalBytesProcessed: "0" } } }]),
    );
    const result = await estimateQueryCost("SELECT 1", {
      projectId: "my-project",
    });
    expect(result).not.toBeNull();
    expect(result!.bytesScanned).toBe(0);
    expect(result!.estimatedCostUsd).toBe(0);
  });

  test("handles missing statistics gracefully", async () => {
    mockCreateQueryJob.mockImplementation(() =>
      Promise.resolve([{ metadata: {} }]),
    );
    const result = await estimateQueryCost("SELECT 1", {
      projectId: "my-project",
    });
    expect(result).not.toBeNull();
    expect(result!.bytesScanned).toBe(0);
    expect(result!.estimatedCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  test("formats kilobytes", () => {
    expect(formatBytes(500_000)).toBe("500.0 KB");
  });

  test("formats megabytes", () => {
    expect(formatBytes(150_000_000)).toBe("150.0 MB");
  });

  test("formats gigabytes", () => {
    expect(formatBytes(2_300_000_000)).toBe("2.3 GB");
  });

  test("formats terabytes", () => {
    expect(formatBytes(1_500_000_000_000)).toBe("1.5 TB");
  });
});

// ---------------------------------------------------------------------------
// Cost approval hook — helper to get the beforeQuery hook handler
// ---------------------------------------------------------------------------

function getBeforeQueryHook(
  config: Parameters<typeof buildBigQueryPlugin>[0],
): PluginHookEntry<QueryHookContext, QueryHookMutation> {
  const plugin = buildBigQueryPlugin(config);
  const hooks = plugin.hooks?.beforeQuery;
  expect(hooks).toBeDefined();
  expect(hooks!.length).toBeGreaterThan(0);
  return hooks![0];
}

function makeHookContext(overrides?: Partial<QueryHookContext>): QueryHookContext {
  return {
    sql: "SELECT * FROM events",
    connectionId: "bigquery-datasource",
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// "threshold" mode (default)
// ---------------------------------------------------------------------------

describe("cost approval: threshold mode", () => {
  test("auto-approves when cost is under threshold", async () => {
    // 5 GB → $0.025, well under default $1.00 threshold
    const hook = getBeforeQueryHook({});
    const ctx = makeHookContext();
    const result = await hook.handler(ctx);
    // Should not throw — undefined/void means proceed
    expect(result).toBeUndefined();
    expect(ctx.metadata!.estimatedCostUsd).toBeCloseTo(0.025);
    expect(ctx.metadata!.bytesScanned).toBe(5_000_000_000);
  });

  test("rejects when cost exceeds threshold", async () => {
    // 500 GB → $2.50, over $1.00 threshold
    mockCreateQueryJob.mockImplementation(() =>
      Promise.resolve([
        { metadata: { statistics: { totalBytesProcessed: "500000000000" } } },
      ]),
    );
    const hook = getBeforeQueryHook({});
    const ctx = makeHookContext();
    await expect(hook.handler(ctx)).rejects.toThrow(/scan ~500\.0 GB.*\$2\.5000.*Approve to execute/);
  });

  test("auto-approves at exactly the threshold boundary", async () => {
    // 200 GB → $1.00, exactly at threshold
    mockCreateQueryJob.mockImplementation(() =>
      Promise.resolve([
        { metadata: { statistics: { totalBytesProcessed: "200000000000" } } },
      ]),
    );
    const hook = getBeforeQueryHook({});
    const ctx = makeHookContext();
    const result = await hook.handler(ctx);
    expect(result).toBeUndefined();
  });

  test("respects custom threshold", async () => {
    // 5 GB → $0.025, over custom $0.01 threshold
    const hook = getBeforeQueryHook({ costThreshold: 0.01 });
    const ctx = makeHookContext();
    await expect(hook.handler(ctx)).rejects.toThrow(/Approve to execute/);
  });

  test("auto-approves under custom threshold", async () => {
    // 5 GB → $0.025, under custom $1.00 threshold
    const hook = getBeforeQueryHook({ costThreshold: 1.0 });
    const ctx = makeHookContext();
    const result = await hook.handler(ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// "auto" mode
// ---------------------------------------------------------------------------

describe("cost approval: auto mode", () => {
  test("always proceeds regardless of cost", async () => {
    // 500 GB → $2.50, but auto mode doesn't gate
    mockCreateQueryJob.mockImplementation(() =>
      Promise.resolve([
        { metadata: { statistics: { totalBytesProcessed: "500000000000" } } },
      ]),
    );
    const hook = getBeforeQueryHook({ costApproval: "auto" });
    const ctx = makeHookContext();
    const result = await hook.handler(ctx);
    expect(result).toBeUndefined();
    expect(ctx.metadata!.estimatedCostUsd).toBeCloseTo(2.5);
  });

  test("attaches cost metadata to context", async () => {
    const hook = getBeforeQueryHook({ costApproval: "auto" });
    const ctx = makeHookContext();
    await hook.handler(ctx);
    expect(ctx.metadata!.estimatedCostUsd).toBeCloseTo(0.025);
    expect(ctx.metadata!.bytesScanned).toBe(5_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// "always" mode
// ---------------------------------------------------------------------------

describe("cost approval: always mode", () => {
  test("always rejects with cost info, even for cheap queries", async () => {
    // 5 GB → $0.025 — very cheap, but always mode still requires approval
    const hook = getBeforeQueryHook({ costApproval: "always" });
    const ctx = makeHookContext();
    await expect(hook.handler(ctx)).rejects.toThrow(/\$0\.0250.*Approve to execute/);
  });

  test("includes bytes scanned in rejection message", async () => {
    const hook = getBeforeQueryHook({ costApproval: "always" });
    const ctx = makeHookContext();
    await expect(hook.handler(ctx)).rejects.toThrow(/5\.0 GB/);
  });
});

// ---------------------------------------------------------------------------
// Dry-run failure handling
// ---------------------------------------------------------------------------

describe("dry-run failure", () => {
  test("proceeds without blocking when dry run fails", async () => {
    mockCreateQueryJob.mockImplementation(() =>
      Promise.reject(new Error("Permission denied")),
    );
    const hook = getBeforeQueryHook({});
    const ctx = makeHookContext();
    // Should not throw — dry-run failure is non-blocking
    const result = await hook.handler(ctx);
    expect(result).toBeUndefined();
    // No cost metadata attached
    expect(ctx.metadata!.estimatedCostUsd).toBeUndefined();
  });

  test("proceeds in always mode when dry run fails", async () => {
    mockCreateQueryJob.mockImplementation(() =>
      Promise.reject(new Error("Network error")),
    );
    const hook = getBeforeQueryHook({ costApproval: "always" });
    const ctx = makeHookContext();
    // Should not throw — can't gate without cost info
    const result = await hook.handler(ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Matcher — only fires for BigQuery connections
// ---------------------------------------------------------------------------

describe("hook matcher", () => {
  test("fires for bigquery-datasource connectionId", () => {
    const hook = getBeforeQueryHook({});
    expect(hook.matcher).toBeDefined();
    expect(hook.matcher!({ sql: "SELECT 1", connectionId: "bigquery-datasource" })).toBe(true);
  });

  test("does not fire for other connectionIds", () => {
    const hook = getBeforeQueryHook({});
    expect(hook.matcher!({ sql: "SELECT 1", connectionId: "default" })).toBe(false);
    expect(hook.matcher!({ sql: "SELECT 1", connectionId: "postgres-main" })).toBe(false);
  });

  test("does not fire when connectionId is undefined", () => {
    const hook = getBeforeQueryHook({});
    expect(hook.matcher!({ sql: "SELECT 1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe("config defaults", () => {
  test("default costApproval is threshold", () => {
    const plugin = bigqueryPlugin({});
    expect(plugin.config?.costApproval).toBe("threshold");
  });

  test("default costThreshold is 1.00", () => {
    const plugin = bigqueryPlugin({});
    expect(plugin.config?.costThreshold).toBe(1.0);
  });

  test("dialect includes cost estimate hint", () => {
    const plugin = buildBigQueryPlugin({});
    expect(plugin.dialect).toContain("cost estimate");
  });
});
