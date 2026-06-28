/**
 * Unit tests for `createSlackWorkspaceIdResolver` (#2620).
 *
 * Covers:
 *   - Non-Slack adapter → null (cross-platform isolation)
 *   - Missing team_id / missing raw → null
 *   - Known team_id → org_id via the consolidated slack/store (#2634)
 *   - Unknown team_id → null
 *   - Slack/store throws → null + log.warn
 *   - `team` field accepted as alias for `team_id`
 *   - `org_id` null in the resolved installation → null
 *
 * Mock notes — same constraints as `enabled-gate.test.ts`:
 *   - `mock.module()` factories are sync; async + inner await deadlocks
 *     the bun loader (CLAUDE.md `feedback_bun_test_async_mock_module`).
 *   - Logger mock returns a fully-stubbed shape — recursing into
 *     `createLogger` inside its own factory hangs the loader.
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

// ── DB internal mock (only `hasInternalDB` matters now) ─────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => mockHasInternalDB(),
}));

// ── Slack store mock ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realStore = require("@atlas/api/lib/slack/store") as typeof import("@atlas/api/lib/slack/store");

const mockGetInstallation: Mock<
  (teamId: string) => Promise<import("@atlas/api/lib/slack/store").SlackInstallationWithSecret | null>
> = mock(async () => null);

mock.module("@atlas/api/lib/slack/store", () => ({
  ...realStore,
  getInstallation: (teamId: string) => mockGetInstallation(teamId),
}));

// ── Module under test (loaded AFTER mocks via sync require) ──────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createSlackWorkspaceIdResolver, __resetContractWarnDedupForTests } = require(
  "../workspace-id-resolver",
) as typeof import("../workspace-id-resolver");

// ── Test helpers ────────────────────────────────────────────────────

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

/** Build a SlackInstallationWithSecret with the given org_id. */
function withOrg(orgId: string | null) {
  return {
    team_id: "T-test",
    bot_token: "xoxb-test",
    org_id: orgId,
    workspace_name: null,
    installed_at: "2025-01-01T00:00:00.000Z",
  };
}

// ── Per-test reset ──────────────────────────────────────────────────

beforeEach(() => {
  mockGetInstallation.mockClear();
  mockGetInstallation.mockImplementation(async () => null);
  mockHasInternalDB.mockClear();
  mockHasInternalDB.mockImplementation(() => true);
  mockLogWarn.mockClear();
  __resetContractWarnDedupForTests();
});

afterEach(() => {
  mockGetInstallation.mockClear();
  mockLogWarn.mockClear();
});

// ── Tests ───────────────────────────────────────────────────────────

describe("createSlackWorkspaceIdResolver", () => {
  it("returns null for a non-Slack adapter without touching the store", async () => {
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(
      makeEvent({ adapterName: "teams", raw: { team_id: "T1" } }),
    );
    expect(out).toBeNull();
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("returns null when message.raw is missing entirely", async () => {
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: undefined }));
    expect(out).toBeNull();
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("returns null when neither team_id nor team is set on the raw payload", async () => {
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { channel: "C1" } }));
    expect(out).toBeNull();
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("returns the org_id from the consolidated store for a known team_id", async () => {
    mockGetInstallation.mockImplementation(async () => withOrg("org-1"));
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-known" } }));
    expect(out).toBe("org-1");

    expect(mockGetInstallation).toHaveBeenCalledTimes(1);
    expect(mockGetInstallation).toHaveBeenCalledWith("T-known");
  });

  it("accepts `team` as an alias for `team_id` (older webhook shapes)", async () => {
    mockGetInstallation.mockImplementation(async () => withOrg("org-1"));
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team: "T-alias" } }));
    expect(out).toBe("org-1");
    expect(mockGetInstallation).toHaveBeenCalledWith("T-alias");
  });

  it("prefers `team_id` over `team` when both are present", async () => {
    mockGetInstallation.mockImplementation(async () => withOrg("org-1"));
    const resolver = createSlackWorkspaceIdResolver();
    await resolver(
      makeEvent({ raw: { team_id: "T-primary", team: "T-fallback" } }),
    );
    expect(mockGetInstallation).toHaveBeenCalledWith("T-primary");
  });

  it("returns null when the store has no row for the team_id", async () => {
    mockGetInstallation.mockImplementation(async () => null);
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-unknown" } }));
    expect(out).toBeNull();
    // Unknown tenant is the expected silent-skip path — no warn.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns null + logs warn when the installation exists but org_id is null (contract violation)", async () => {
    // Post-#2677: distinguish "unknown tenant" (row absent) from
    // "contract violation" (row exists, Atlas-extension orgId missing).
    // The latter is the #2676 outage mode — the chat-adapter wrote the
    // row without orgId. The pg-adapter JSONB merge fixes the write
    // side; this warn catches any write path that still bypasses it
    // (e.g. a future state backend, or a direct INSERT).
    mockGetInstallation.mockImplementation(async () => withOrg(null));
    const resolver = createSlackWorkspaceIdResolver();
    const out = await resolver(makeEvent({ raw: { team_id: "T-unbound" } }));
    expect(out).toBeNull();

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLogWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(payload.teamId).toBe("T-unbound");
    expect(message).toContain("orgId");
    // No `err` field on the contract-violation warn — distinguishes it
    // from the catch-block warn (which carries `err` + pg `code`). A
    // future refactor that funnels the null-org_id case through the
    // catch path would silently regress the operator-facing signal.
    expect(payload.err).toBeUndefined();
    expect(payload.code).toBeUndefined();
  });

  it("deduplicates the contract-violation warn for the same teamId within the dedup window", async () => {
    // A stuck-orgId tenant emits Slack events continuously; a warn per
    // event is unbounded log spend for a condition that's actionable
    // from a single occurrence. The dedup keeps log volume bounded
    // while preserving the "fail-loud once" guarantee.
    mockGetInstallation.mockImplementation(async () => withOrg(null));
    const resolver = createSlackWorkspaceIdResolver();
    await resolver(makeEvent({ raw: { team_id: "T-stuck" } }));
    await resolver(makeEvent({ raw: { team_id: "T-stuck" } }));
    await resolver(makeEvent({ raw: { team_id: "T-stuck" } }));

    // Only one warn for three back-to-back events from the same team.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it("warns separately for each distinct teamId in the contract-violation branch", async () => {
    // Dedup is per-teamId — two different stuck tenants should each
    // surface once, not be silenced by the first one's warn.
    mockGetInstallation.mockImplementation(async () => withOrg(null));
    const resolver = createSlackWorkspaceIdResolver();
    await resolver(makeEvent({ raw: { team_id: "T-stuck-a" } }));
    await resolver(makeEvent({ raw: { team_id: "T-stuck-b" } }));

    expect(mockLogWarn).toHaveBeenCalledTimes(2);
    const teamIds = mockLogWarn.mock.calls.map(
      (c) => (c[0] as { teamId: string }).teamId,
    );
    expect(teamIds).toEqual(["T-stuck-a", "T-stuck-b"]);
  });

  it("returns null + logs warn when the store throws", async () => {
    mockGetInstallation.mockImplementation(async () => {
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
    expect(message).toContain("chat_cache");
  });

  it("includes the pg error `code` on the warn payload", async () => {
    const err = Object.assign(new Error("undefined table"), {
      code: "42P01",
    });
    mockGetInstallation.mockImplementation(async () => {
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
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  it("never throws — defensive contract", async () => {
    mockGetInstallation.mockImplementation(async () => {
      throw new Error("boom");
    });
    const resolver = createSlackWorkspaceIdResolver();
    await expect(
      resolver(makeEvent({ raw: { team_id: "T-x" } })),
    ).resolves.toBeNull();
  });
});
