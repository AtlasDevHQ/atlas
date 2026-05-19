/**
 * Unit tests for `createSlackWorkspaceIdResolver` (#2620).
 *
 * Covers:
 *   - Non-Slack adapter → null (cross-platform isolation)
 *   - Missing team_id / missing raw → null
 *   - Known team_id → org_id from slack_installations
 *   - Unknown team_id → null
 *   - DB throws → null + log.warn
 *   - `team` field accepted as alias for `team_id`
 *   - `org_id` null in the DB row → null
 *
 * Mock notes — same constraints as `enabled-gate.test.ts`:
 *   - `mock.module()` factories are sync; async + inner await deadlocks
 *     the bun loader (CLAUDE.md `feedback_bun_test_async_mock_module`).
 *   - Logger mock returns a fully-stubbed shape — recursing into
 *     `createLogger` inside its own factory hangs the loader.
 *   - Module-under-test is loaded via `require()` AFTER mocks; `await
 *     import(...)` between mock + load is also a known deadlock path.
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
const { createSlackWorkspaceIdResolver } = require(
  "../workspace-id-resolver",
) as typeof import("../workspace-id-resolver");

// ── Test helpers ────────────────────────────────────────────────────

/**
 * Build a resolver event with the minimum surface the resolver reads
 * (`adapter.name`, `message.raw`). Tests pass `null` for `thread`
 * because the Slack resolver never inspects it.
 */
function makeEvent(opts: {
  adapterName?: string;
  raw?: Record<string, unknown> | null | undefined;
}): Parameters<ReturnType<typeof createSlackWorkspaceIdResolver>>[0] {
  return {
    adapter: { name: opts.adapterName ?? "slack" },
    thread: {},
    message: { raw: opts.raw },
  } as unknown as Parameters<
    ReturnType<typeof createSlackWorkspaceIdResolver>
  >[0];
}

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

// ── Tests ───────────────────────────────────────────────────────────

describe("createSlackWorkspaceIdResolver", () => {
  it("returns null for a non-Slack adapter without touching the DB", async () => {
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(
      makeEvent({ adapterName: "teams", raw: { team_id: "T1" } }),
    );
    expect(out).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns null when message.raw is missing entirely", async () => {
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: undefined }));
    expect(out).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns null when neither team_id nor team is set on the raw payload", async () => {
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { channel: "C1" } }));
    expect(out).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns the org_id from slack_installations for a known team_id", async () => {
    mockInternalQuery.mockImplementation(async () => [{ org_id: "org-1" }]);
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-known" } }));
    expect(out).toBe("org-1");

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0]!;
    expect(sql).toContain("slack_installations");
    expect(sql).toContain("SELECT org_id");
    expect(params).toEqual(["T-known"]);
  });

  it("accepts `team` as an alias for `team_id` (older webhook shapes)", async () => {
    mockInternalQuery.mockImplementation(async () => [{ org_id: "org-1" }]);
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team: "T-alias" } }));
    expect(out).toBe("org-1");

    const [, params] = mockInternalQuery.mock.calls[0]!;
    expect(params).toEqual(["T-alias"]);
  });

  it("prefers `team_id` over `team` when both are present", async () => {
    mockInternalQuery.mockImplementation(async () => [{ org_id: "org-1" }]);
    const resolver = createSlackWorkspaceIdResolver();
    await resolver(
      makeEvent({ raw: { team_id: "T-primary", team: "T-fallback" } }),
    );
    const [, params] = mockInternalQuery.mock.calls[0]!;
    expect(params).toEqual(["T-primary"]);
  });

  it("returns null when slack_installations has no row for the team_id", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-unknown" } }));
    expect(out).toBeNull();
    // Unknown tenant is the expected silent-skip path — no warn.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns null when the row exists but org_id is null", async () => {
    // Slack installations can exist without an org binding (e.g. an
    // install that hasn't completed onboarding). Treat as unknown.
    mockInternalQuery.mockImplementation(async () => [{ org_id: null }]);
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-unbound" } }));
    expect(out).toBeNull();
  });

  it("returns null + logs warn when the DB query throws", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-down" } }));
    expect(out).toBeNull();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.teamId).toBe("T-down");
    expect(payload.err).toBe("connection refused");
    expect(message).toContain("slack_installations");
  });

  it("includes the pg error `code` on the warn payload", async () => {
    const err = Object.assign(new Error("undefined table"), {
      code: "42P01",
    });
    mockInternalQuery.mockImplementation(async () => {
      throw err;
    });
    const resolver = createSlackWorkspaceIdResolver();
    await resolver(makeEvent({ raw: { team_id: "T-x" } }));

    const [payload] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(payload.code).toBe("42P01");
  });

  it("returns null when the internal DB is unavailable", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-x" } }));
    expect(out).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("never throws — defensive contract", async () => {
    // Even with the DB layer wired to throw, the resolver must
    // resolve (returning null), never reject. The chat plugin's
    // safe-wrapper provides defence in depth, but a clean resolver
    // returns null on every error path so warn rows line up with
    // rejected events.
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("boom");
    });
    const resolver = createSlackWorkspaceIdResolver();
    await expect(
      resolver(makeEvent({ raw: { team_id: "T-x" } })),
    ).resolves.toBeNull();
  });
});
