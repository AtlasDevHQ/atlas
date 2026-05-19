/**
 * Unit tests for the workspace + channel config loaders (#2620).
 *
 * Covers `getWorkspaceProactiveConfig` + `getChannelProactiveConfigs`:
 *   - Workspace row missing → null
 *   - Workspace row present → { enabled, sensitivity, classifierMode }
 *   - Sensitivity / classifier_mode out-of-enum drift → safe defaults
 *   - DB throws → null / [] + log.warn
 *   - Channels: zero rows → []
 *   - Channels: multiple rows → ordered + nullable sensitivity dropped
 *
 * Mock notes — same constraints as `workspace-id-resolver.test.ts`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  type Mock,
} from "bun:test";

// ── Logger mock ─────────────────────────────────────────────────────

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    warn: mockLogWarn,
    info: () => {},
    debug: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    child: () => ({
      warn: mockLogWarn,
      info: () => {},
      debug: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      silent: () => {},
    }),
  }),
}));

// ── DB internal mock ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

const mockInternalQuery: Mock<
  (sql: string, params: unknown[]) => Promise<unknown[]>
> = mock(async () => []);
const mockHasInternalDB: Mock<() => boolean> = mock(() => true);

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: (sql: string, params: unknown[]) =>
    mockInternalQuery(sql, params),
  hasInternalDB: () => mockHasInternalDB(),
}));

// ── Module under test (loaded AFTER mocks via sync require) ──────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const loader = require("../workspace-config-loader") as typeof import("../workspace-config-loader");
const { getWorkspaceProactiveConfig, getChannelProactiveConfigs } = loader;

// ── Per-test reset ──────────────────────────────────────────────────

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => []);
  mockHasInternalDB.mockClear();
  mockHasInternalDB.mockImplementation(() => true);
  mockLogWarn.mockClear();
});

afterEach(() => {
  mockInternalQuery.mockClear();
  mockLogWarn.mockClear();
});

// ── getWorkspaceProactiveConfig ──────────────────────────────────────

describe("getWorkspaceProactiveConfig", () => {
  it("returns null when no workspace row exists", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out).toBeNull();
    // Row missing is the expected "not opted in" path — no warn.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns the parsed config when the workspace row exists", async () => {
    mockInternalQuery.mockImplementation(async () => [
      {
        enabled: true,
        sensitivity: "eager",
        classifier_mode: "classify-all",
      },
    ]);
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out).toEqual({
      enabled: true,
      sensitivity: "eager",
      classifierMode: "classify-all",
    });

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("workspace_proactive_config");
    expect(sql).toContain("classifier_mode");
    expect(params).toEqual(["ws-1"]);
  });

  it("falls back to balanced sensitivity on schema drift (non-enum value)", async () => {
    mockInternalQuery.mockImplementation(async () => [
      {
        enabled: true,
        sensitivity: "extreme", // not in the enum
        classifier_mode: "regex-prefilter",
      },
    ]);
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out?.sensitivity).toBe("balanced");
  });

  it("falls back to regex-prefilter classifier mode on schema drift", async () => {
    mockInternalQuery.mockImplementation(async () => [
      {
        enabled: true,
        sensitivity: "balanced",
        classifier_mode: "future-mode-not-yet-defined",
      },
    ]);
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out?.classifierMode).toBe("regex-prefilter");
  });

  it("returns null + logs warn when the workspace DB query throws", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out).toBeNull();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.err).toBe("connection refused");
    expect(message).toContain("workspace_proactive_config");
  });

  it("propagates the pg error `code` onto the warn payload", async () => {
    const err = Object.assign(new Error("undefined table"), { code: "42P01" });
    mockInternalQuery.mockImplementation(async () => {
      throw err;
    });
    await getWorkspaceProactiveConfig("ws-1");
    const [payload] = mockLogWarn.mock.calls[0] as [Record<string, unknown>];
    expect(payload.code).toBe("42P01");
  });

  it("returns null when the internal DB is unavailable", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("treats enabled as boolean — falsy values resolve to false", async () => {
    mockInternalQuery.mockImplementation(async () => [
      {
        enabled: 0,
        sensitivity: "balanced",
        classifier_mode: "regex-prefilter",
      },
    ]);
    const out = await getWorkspaceProactiveConfig("ws-1");
    expect(out?.enabled).toBe(false);
  });
});

// ── getChannelProactiveConfigs ───────────────────────────────────────

describe("getChannelProactiveConfigs", () => {
  it("returns an empty array when no overrides exist", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const out = await getChannelProactiveConfigs("ws-1");
    expect(out).toEqual([]);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns mapped overrides with sensitivity carried through", async () => {
    mockInternalQuery.mockImplementation(async () => [
      { channel_id: "C-1", allow: true, sensitivity: "cautious" },
      { channel_id: "C-2", allow: false, sensitivity: null },
    ]);
    const out = await getChannelProactiveConfigs("ws-1");
    expect(out).toEqual([
      { channelId: "C-1", allow: true, sensitivity: "cautious" },
      { channelId: "C-2", allow: false },
    ]);

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("channel_proactive_config");
    expect(sql).toContain("ORDER BY channel_id");
    expect(params).toEqual(["ws-1"]);
  });

  it("drops out-of-enum sensitivity to the safe default rather than carrying drift", async () => {
    mockInternalQuery.mockImplementation(async () => [
      { channel_id: "C-1", allow: true, sensitivity: "weird" },
    ]);
    const out = await getChannelProactiveConfigs("ws-1");
    expect(out[0]!.sensitivity).toBe("balanced");
  });

  it("returns [] + logs warn when the channel DB query throws", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("table is locked");
    });
    const out = await getChannelProactiveConfigs("ws-1");
    expect(out).toEqual([]);

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.err).toBe("table is locked");
    expect(message).toContain("channel_proactive_config");
  });

  it("returns [] when the internal DB is unavailable", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    const out = await getChannelProactiveConfigs("ws-1");
    expect(out).toEqual([]);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("normalises `allow` to boolean", async () => {
    mockInternalQuery.mockImplementation(async () => [
      { channel_id: "C-1", allow: 1, sensitivity: null },
      { channel_id: "C-2", allow: 0, sensitivity: null },
    ]);
    const out = await getChannelProactiveConfigs("ws-1");
    expect(out[0]!.allow).toBe(false);
    expect(out[1]!.allow).toBe(false);
    // Truthy non-`true` values are coerced — only literal `true` passes
    // through. The DB column is `BOOLEAN NOT NULL`, so this is purely
    // defensive against driver type-shape drift.
  });
});
