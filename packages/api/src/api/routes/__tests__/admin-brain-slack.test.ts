/**
 * Route-level tests for `admin-brain-slack` (#5203, PR #5209 round 2).
 *
 * The scope library's behaviour is pinned against real Postgres in
 * `lib/brain/ingest/__tests__/brain-source-scope-pg.test.ts`. The assertions
 * HERE are about this router, and specifically the four things that would be
 * silent if they broke:
 *
 *   - **The owner/admin bar holds on BOTH write verbs.** Exclusion is a
 *     confidentiality decision and re-inclusion widens retention; a regression
 *     admitting `role: "member"` lets a non-admin undo an admin's decision
 *     with nothing red anywhere.
 *   - **A malformed channel id is a 400 BY TYPE, on both verbs.** The round-1
 *     version matched an error-message substring, so a rewording silently
 *     turned the 400 into a 500 — and the include verb had no validation at
 *     all while its OpenAPI contract documented a 400 it could never produce.
 *     The scope module is deliberately NOT mocked here, so the REAL
 *     normalizer, the REAL `InvalidSlackChannelIdError`, and the route's
 *     `instanceof` mapping are all on the tested path.
 *   - **`changed` is honest.** The schema promises "false when the verb was a
 *     no-op"; round 2 found the exclude handler hardcoding `true`, telling an
 *     admin their re-exclusion took effect while the recorded author stayed
 *     someone else's.
 *   - **The sync verdict block is served.** The retirement removed the
 *     collection card that used to render `knowledge_sync_state`, so this
 *     route's `sync` field is the ONLY place a revoked Slack credential's
 *     actionable error reaches an admin. A route that stopped returning it
 *     would rebuild the green-but-frozen surface the whole ticket is about.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { validationHook } from "../validation-hook";

const CURRENT_ORG = "org-brain-slack";

// ── db/internal: a dispatching internalQuery so the REAL scope functions run
// against scripted rows. Keyed on statement CONTENT (each statement's table
// is distinctive) rather than full-text identity — these tests are about the
// route, not the SQL, which the -pg suite executes for real.
let syncStateRows: Record<string, unknown>[] = [];
let excludePriorWasExcluded: boolean | null = null;
const queriesRun: string[] = [];
const internalQuery = async (sql: string): Promise<Record<string, unknown>[]> => {
  queriesRun.push(sql);
  if (sql.includes("FROM knowledge_sync_state")) return syncStateRows;
  if (sql.includes("WITH prior")) return [{ was_excluded: excludePriorWasExcluded }];
  return [];
};
const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: internalQuery as (sql: string, params?: unknown[]) => Promise<unknown[]>,
  }),
  getInternalDB: () => INTERNAL_DB,
}));

// Mock-ALL-exports, per the vocabulary harness's rationale.
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    setLogLevel: noop,
    ACTOR_KINDS: ["user", "system"] as const,
  };
});

// The reader context, role-driven — the router's branching is under test, the
// resolver's own contract is pinned in `reader-context.test.ts`.
let READER_ROLE: "owner" | "admin" | "member" = "admin";
class TestBrainReaderIdentityError extends Error {}
void mock.module("@atlas/api/lib/brain/reader-context", () => ({
  BrainReaderIdentityError: TestBrainReaderIdentityError,
  BrainReaderUnresolvedError: class extends TestBrainReaderIdentityError {},
  BrainRoleUnresolvedError: class extends TestBrainReaderIdentityError {},
  resolveBrainReaderContext: async () => ({
    origin: "authenticated" as const,
    workspaceId: CURRENT_ORG,
    userId: "user-1",
    role: READER_ROLE,
    audienceIds: [] as readonly string[],
  }),
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono({ defaultHook: validationHook }),
  createPlatformRouter: () => new OpenAPIHono({ defaultHook: validationHook }),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  enforcePermission: async () => null,
  NO_INTERNAL_DB_MESSAGE: "No internal database configured.",
  NO_ACTIVE_ORG_MESSAGE: "No active organization. Set an active org first.",
  noActiveOrgBody: (requestId: string) => ({
    error: "no_active_org",
    message: "No active organization. Set an active org first.",
    requestId,
  }),
  requireOrgContext:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
      await next();
    },
}));

const { AuthContext, RequestContext } = await import("@atlas/api/lib/effect/services");
let ORG_ID: string | undefined = CURRENT_ORG;
void mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: (_c: unknown, program: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(
      Effect.provide(
        program,
        Layer.mergeAll(
          Layer.succeed(RequestContext, {
            requestId: "test-req",
            startTime: 0,
            atlasMode: "published" as const,
          }),
          Layer.succeed(AuthContext, {
            mode: "managed" as const,
            user: { id: "user-1", role: "admin" } as never,
            orgId: ORG_ID,
            trustDeviceIdentifier: undefined,
          }),
        ),
      ) as Effect.Effect<unknown, never, never>,
    ),
}));

const { adminBrainSlack } = await import("../admin-brain-slack");

const post = (path: string, body: unknown) =>
  adminBrainSlack.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  READER_ROLE = "admin";
  ORG_ID = CURRENT_ORG;
  syncStateRows = [];
  excludePriorWasExcluded = null;
  queriesRun.length = 0;
});

describe("POST /channels/exclude", () => {
  it("excludes with a normalized id and an honest changed: true", async () => {
    const res = await post("/channels/exclude", { channelId: " c01abcdef " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelId: "C01ABCDEF", changed: true });
  });

  it("answers changed: false for a channel that was already excluded", async () => {
    // The prior-state CTE reports an existing exclusion; the verb no-oped and
    // must say so — the recorded author is still someone else's.
    excludePriorWasExcluded = true;
    const res = await post("/channels/exclude", { channelId: "C01ABCDEF" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelId: "C01ABCDEF", changed: false });
  });

  it("400s a malformed id by TYPE, carrying the validator's own sentence", async () => {
    const res = await post("/channels/exclude", { channelId: "not-a-channel!" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid-channel-id");
    expect(body.message).toContain("is not a Slack channel ID");
    // The write was never attempted.
    expect(queriesRun.some((q) => q.includes("INSERT INTO brain_slack_channel"))).toBe(false);
  });

  it("403s a member, without touching the exclusion table", async () => {
    READER_ROLE = "member";
    const res = await post("/channels/exclude", { channelId: "C01ABCDEF" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not-entitled");
    expect(queriesRun.some((q) => q.includes("INSERT INTO brain_slack_channel"))).toBe(false);
  });
});

describe("POST /channels/include", () => {
  it("400s a malformed id — the contract used to document a 400 this verb could never produce", async () => {
    const res = await post("/channels/include", { channelId: "definitely wrong" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid-channel-id");
    expect(queriesRun.some((q) => q.includes("UPDATE brain_slack_channel"))).toBe(false);
  });

  it("403s a member — re-inclusion WIDENS retention and gets the same bar", async () => {
    READER_ROLE = "member";
    const res = await post("/channels/include", { channelId: "C01ABCDEF" });
    expect(res.status).toBe(403);
    expect(queriesRun.some((q) => q.includes("UPDATE brain_slack_channel"))).toBe(false);
  });

  it("includes with changed reflecting whether an exclusion was cleared", async () => {
    // internalQuery returns no rows for the UPDATE … RETURNING, so nothing was
    // excluded → changed: false, per the schema's no-op contract.
    const res = await post("/channels/include", { channelId: "g0private1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelId: "G0PRIVATE1", changed: false });
  });
});

describe("GET /channels", () => {
  it("serves the sync verdict — the one surface a revoked credential's error reaches", async () => {
    syncStateRows = [
      {
        last_sync_at: new Date("2026-08-13T01:00:00.000Z"),
        status: "error",
        error:
          "The workspace's Slack credential is no longer valid — reconnect Slack under Admin → Integrations",
        report: { coverageIncomplete: false },
      },
    ];
    const res = await adminBrainSlack.request("/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scopeMode: string;
      sync: {
        lastSyncAt: string | null;
        status: string;
        error: string | null;
        coverageIncomplete: boolean;
      } | null;
    };
    expect(body.sync).toEqual({
      lastSyncAt: "2026-08-13T01:00:00.000Z",
      status: "error",
      error:
        "The workspace's Slack credential is no longer valid — reconnect Slack under Admin → Integrations",
      coverageIncomplete: false,
    });
  });

  it("serves sync: null before the first recorded attempt — distinct from an error", async () => {
    const res = await adminBrainSlack.request("/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sync: unknown };
    expect(body.sync).toBeNull();
  });
});
