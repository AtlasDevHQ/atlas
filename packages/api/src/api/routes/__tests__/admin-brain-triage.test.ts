/**
 * Route-level tests for `admin-brain-triage` (#5534).
 *
 * The store's behaviour is pinned in `lib/brain/__tests__/triage-requeue.test.ts`;
 * what this file owns is the ROUTER's obligations, and three of them would be
 * silent if they broke:
 *
 *   1. **The owner/admin bar on BOTH verbs.** `adminAuth` gates this router on
 *      the SESSION's role, which does not know which workspace is being read.
 *      The bar that does is re-resolved per request, and it is applied to the
 *      count as well as the write — an asymmetry with the fact router that the
 *      route header argues for and this file makes falsifiable.
 *   2. **The workspace the bar VERIFIED is the workspace the store was handed.**
 *      Threading `orgId` past a check made against a re-resolved context is the
 *      agree-by-construction shape `sweepTarget` exists to refuse; here the
 *      assertion is on the argument the seam received.
 *   3. **A committed re-queue is never reported as "nothing happened".** The
 *      audit row is the only durable record of this act, so its failure has to
 *      surface — and the message has to say the write LANDED, because a retry
 *      would re-queue nothing and read as a second failure.
 *
 * Whether the SQL clears the right rows is `triage-requeue.test.ts`' question
 * against the statements and `triage-requeue-pg.test.ts`' against the live
 * schema; a double cannot answer it.
 *
 * ⚠️ So is WHO did it. This file mocks `@atlas/api/lib/audit` wholesale, so it
 * asserts the audit ENTRY OBJECT — which carries no actor, because `actor_id`
 * is resolved inside the function the double replaces.
 * `admin-brain-triage-attribution.test.ts` is where that is proven, on #5448's
 * shape, and it is not optional here: naming the human is the reason this
 * surface is an admin route at all.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";
// Type-only: erased before `mock.module` runs, so it borrows the shape without
// evaluating the module (and its extraction-fiber graph) this file stubs.
import type { TriageBacklog } from "@atlas/api/lib/brain/triage-requeue";

const CURRENT_ORG = "org-1";

const INTERNAL_DB = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => INTERNAL_DB,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test-req" }) };
});

// BOTH audit helpers, on `admin-brain-facts.test.ts`'s reasoning: a partial
// factory fails with `undefined is not a function`, which reads as a broken
// test rather than the wrong helper being reached for.
const auditRows: Array<Record<string, unknown>> = [];
/** Set to make the AWAITED audit write reject — the arm the 500 below guards. */
let auditThrows: Error | null = null;
void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => auditRows.push(entry),
  logAdminActionAwait: async (entry: Record<string, unknown>) => {
    if (auditThrows !== null) throw auditThrows;
    auditRows.push(entry);
  },
  // The REAL catalog rather than a hand-copy: a copy drifts silently through a
  // rename. `lib/audit/actions.ts` is a zero-import constant module, so
  // reaching past the mocked barrel into it pulls nothing back in.
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
}));

class MemberRoleLookupError extends Error {}
/** The member row this workspace's lookup finds. `null` models "no member row". */
let memberRoleResult: string | null = "admin";
void mock.module("@atlas/api/lib/auth/effective-role", () => ({
  resolveEffectiveRole: async (userRole: unknown) => memberRoleResult ?? userRole,
  resolveEffectiveRoleStrict: async (userRole: unknown) =>
    memberRoleResult === null
      ? { role: userRole, fromMemberRow: false }
      : { role: memberRoleResult, fromMemberRow: true },
  MemberRoleLookupError,
}));

/**
 * The store seam. EVERY named export, not just the three the route calls:
 * `mock.module` is file-global, so a partial factory link-fails the moment
 * anything else in the graph imports an omitted name.
 *
 * ⚠️ `isKnownTriageRule` is the REAL predicate over the rule tuple below, not a
 * `() => true` stub. The route's 400 arm is only meaningful if the membership
 * test is the one the server actually runs, and a permissive stub would make
 * the unknown-rule test pass against a route that had stopped checking.
 */
const TRIAGE_RULE_TUPLE = ["below_min_length", "pure_reaction", "known_ack"] as const;
let backlogCalls: string[] = [];
let backlogResponse: TriageBacklog = { total: 0, byRule: [] };
let requeueCalls: { workspaceId: string; rule: string | null }[] = [];
let requeueResult = { requeued: 0 };
/** Set to make the store THROW — the arm a double cannot otherwise reach. */
let requeueThrows: Error | null = null;
void mock.module("@atlas/api/lib/brain/triage-requeue", () => ({
  TRIAGE_BACKLOG_SQL: "SELECT triage_reason FROM brain_episodes",
  REQUEUE_TRIAGED_COUNTED_SQL: "WITH requeued AS (UPDATE brain_episodes)",
  isKnownTriageRule: (rule: string) => (TRIAGE_RULE_TUPLE as readonly string[]).includes(rule),
  loadTriageBacklog: async (_db: unknown, workspaceId: string) => {
    backlogCalls.push(workspaceId);
    return backlogResponse;
  },
  requeueTriagedEpisodes: async (_db: unknown, workspaceId: string, rule: string | null) => {
    requeueCalls.push({ workspaceId, rule });
    if (requeueThrows !== null) throw requeueThrows;
    return requeueResult;
  },
}));

/**
 * SENTINEL rationales, deliberately not the shipped prose.
 *
 * `GET /` projects the rule list into its response, and the route also renders
 * rule ids into the 400's message. Feeding the mock the real rationales could
 * not detect a route that had substituted its own copy — the literal and the
 * constant would agree, which is the fixtures-agree-by-construction trap
 * `admin-brain-facts.test.ts` names at its cap sentinels. Prose nothing else in
 * the tree produces makes the projection falsifiable.
 */
const SENTINEL_RATIONALE = "sentinel rationale — pinned by admin-brain-triage.test.ts";
void mock.module("@atlas/api/lib/brain/triage", () => ({
  TRIAGE_RULE_IDS: TRIAGE_RULE_TUPLE,
  TRIAGE_MIN_MEANINGFUL_CHARS: 2,
  TRIAGE_RULES: TRIAGE_RULE_TUPLE.map((id) => ({
    id,
    rationale: `${SENTINEL_RATIONALE} (${id})`,
    matches: () => false,
  })),
  normalizeForAck: (s: string) => s,
  triageEpisodeBody: () => null,
  emptyTriageMatchCounts: () => ({ below_min_length: 0, pure_reaction: 0, known_ack: 0 }),
}));

/**
 * The gate's own switch, stubbed rather than driven through settings: what the
 * route owes is that it REPORTS the flag, and a settings-shaped fake would test
 * the settings registry instead. Mutable so both states are reachable — the
 * off-with-a-backlog case is the one the response field exists for.
 */
let triageEnabled = false;
// EVERY named export, on the sibling factories' terms: `mock.module` is
// file-global, so a partial factory link-fails the moment anything else in this
// file's graph imports an omitted name. It does not today — the route reaches
// `extract` for one function — which is exactly the condition the rule exists
// for, and `admin-brain-facts.test.ts`'s five factories each enumerate names
// nobody currently uses for the same reason. The re-exported contract/batch
// names are listed too, since `extract.ts` publishes them as its own.
void mock.module("@atlas/api/lib/brain/extract", () => ({
  BRAIN_EXTRACTION_ACTOR: "system:brain-extraction",
  BATCH_SIZE: 25,
  QUARANTINE_AFTER_FAILURES: 3,
  QUARANTINE_PROBE_BASE_MS: 30 * 60 * 1000,
  ALIAS_PROPOSAL_DEADLINE_MS: 15_000,
  DRAIN_EPISODES_SQL: "SELECT 1 FROM brain_episodes",
  STAMP_EXTRACTED_SQL: "UPDATE brain_episodes",
  MARK_TRIAGED_SQL: "UPDATE brain_episodes",
  REQUEUE_TRIAGED_SQL: "UPDATE brain_episodes",
  EXTRACTION_SKIP_REASONS: [
    "model_unavailable",
    "no_body",
    "quarantined",
    "triaged",
  ] as const,
  isBrainExtractionEnabled: () => false,
  isBrainExtractionBatchEnabled: () => false,
  isBrainExtractionTriageEnabled: () => triageEnabled,
  getBrainExtractionIntervalMs: () => 60_000,
  _resetBrainExtractionFailures: () => {},
  backingOffIds: () => [] as string[],
  llmFactExtractor: async () => [],
  resolveExtractionModel: async () => null,
  runBrainExtractionCycle: () => {
    throw new Error("the extraction cycle must never run from a route test");
  },
  // `extract.ts` re-exports these from `extract-contract` / `extract-batch`
  // and callers import them FROM `extract`, so the double owes them too.
  BRAIN_EXTRACTION_PRODUCER: "brain:extraction",
  EXTRACTION_SYSTEM_PROMPT: "",
  ExtractionSchema: {},
  extractionExcerpt: () => "",
  extractionPrompt: () => "",
  toFactCandidates: () => [],
}));

void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
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
let AUTH_USER: { id: string; role?: string } | undefined = { id: "user-1", role: "member" };
/** Mutable so the org-less arm each handler guards is reachable under test. */
let ORG_ID: string | undefined = CURRENT_ORG;
/**
 * `unauthenticated-local` is the DEFAULT self-hosted deploy mode, so without
 * this lever that arm of the bar is unreachable and inverting it would lock
 * every self-hosted install out of the surface with nothing going red.
 */
let AUTH_MODE: "managed" | "none" = "managed";
void mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: (_c: unknown, program: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(
      Effect.provide(
        program as Effect.Effect<unknown, unknown, never>,
        Layer.mergeAll(
          Layer.succeed(RequestContext, {
            requestId: "test-req",
            startTime: 0,
            atlasMode: "published" as const,
          }),
          Layer.succeed(AuthContext, {
            mode: AUTH_MODE,
            user: AUTH_USER as never,
            orgId: ORG_ID,
            trustDeviceIdentifier: undefined,
          }),
        ),
      ) as Effect.Effect<unknown, never, never>,
    ),
}));

const { adminBrainTriage } = await import("../admin-brain-triage");

function post(body?: unknown) {
  return adminBrainTriage.request("/requeue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  auditRows.length = 0;
  auditThrows = null;
  memberRoleResult = "admin";
  backlogCalls = [];
  backlogResponse = { total: 0, byRule: [] };
  requeueCalls = [];
  requeueResult = { requeued: 0 };
  requeueThrows = null;
  triageEnabled = false;
  AUTH_USER = { id: "user-1", role: "member" };
  ORG_ID = CURRENT_ORG;
  AUTH_MODE = "managed";
});

describe("GET /", () => {
  it("reports the backlog, the live rule list, and the gate's state", async () => {
    triageEnabled = true;
    backlogResponse = {
      total: 14,
      byRule: [
        { rule: "known_ack", episodes: 12, known: true },
        { rule: "channel_join_notice", episodes: 2, known: false },
      ],
    };

    const res = await adminBrainTriage.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: 14,
      byRule: [
        { rule: "known_ack", episodes: 12, known: true },
        { rule: "channel_join_notice", episodes: 2, known: false },
      ],
      rules: TRIAGE_RULE_TUPLE.map((id) => ({ id, rationale: `${SENTINEL_RATIONALE} (${id})` })),
      enabled: true,
    });
  });

  it("projects the rules from the module rather than a copy of its own", async () => {
    const body = (await (await adminBrainTriage.request("/")).json()) as {
      rules: { id: string; rationale: string }[];
    };
    // The sentinel prose is what makes this falsifiable — a route that had
    // inlined the shipped rationales would return text this fixture never
    // produced. `matches` must NOT travel: a predicate is not serialisable, and
    // the wire schema is strict, so leaking it would 500 here.
    expect(body.rules.every((r) => r.rationale.startsWith(SENTINEL_RATIONALE))).toBe(true);
    expect(body.rules.every((r) => !("matches" in r))).toBe(true);
  });

  it("reports the gate OFF with a non-zero backlog — the two are different states", async () => {
    triageEnabled = false;
    backlogResponse = { total: 9, byRule: [{ rule: "known_ack", episodes: 9, known: true }] };
    const body = (await (await adminBrainTriage.request("/")).json()) as Record<string, unknown>;
    // Marks a previous run left behind: a finite backlog, not a growing one.
    // Rendering them as the same panel is the mistake `enabled` exists to stop.
    expect(body).toMatchObject({ total: 9, enabled: false });
  });

  it("hands the store the workspace the bar verified", async () => {
    await adminBrainTriage.request("/");
    expect(backlogCalls).toEqual([CURRENT_ORG]);
  });

  it("refuses a reader below the owner/admin bar", async () => {
    memberRoleResult = "member";
    const res = await adminBrainTriage.request("/");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    // The count is not served on the way to the refusal.
    expect(backlogCalls).toEqual([]);
  });

  it("serves an owner", async () => {
    memberRoleResult = "owner";
    expect((await adminBrainTriage.request("/")).status).toBe(200);
  });

  it("serves the unauthenticated-local arm — which this router cannot actually reach", async () => {
    // ⚠️ Read the title literally. `triageTarget`'s `unauthenticated-local`
    // case exists for EXHAUSTIVENESS over `BrainPrincipalContext` (a fourth
    // origin must be a compile error, not an inherited default) and mirrors
    // `sweepTarget` one router over. It is NOT reachable in production behind
    // this router: `ATLAS_AUTH_MODE=none` yields `{ user: undefined }`
    // (`lib/auth/middleware.ts`), and `requireOrgContext()` reads
    // `authResult.user?.activeOrganizationId` and 400s before any handler runs.
    //
    // An earlier version of this test claimed inverting the arm "would lock
    // every self-hosted install out of the surface". That was false — the arm
    // is defensive, and the real self-hosted path onto this router is an
    // authenticated admin. The test is kept because the arm is kept, and it
    // says what it actually covers: the switch's own totality.
    AUTH_MODE = "none";
    AUTH_USER = undefined;
    expect((await adminBrainTriage.request("/")).status).toBe(200);
  });

  it("400s without an active organization", async () => {
    ORG_ID = undefined;
    const res = await adminBrainTriage.request("/");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_active_org");
  });
});

describe("POST /requeue", () => {
  it("re-queues every rule when no rule is given, and audits the act", async () => {
    requeueResult = { requeued: 31 };
    const res = await post({});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requeued: 31, rule: null });
    expect(requeueCalls).toEqual([{ workspaceId: CURRENT_ORG, rule: null }]);
    expect(auditRows).toEqual([
      {
        actionType: REAL_ADMIN_ACTIONS.brain.triageRequeue,
        targetType: "brain",
        targetId: CURRENT_ORG,
        metadata: { workspaceId: CURRENT_ORG, rule: null, requeued: 31 },
      },
    ]);
  });

  it("treats an explicit null rule and an absent one as the same scope", async () => {
    await post({ rule: null });
    await post({});
    expect(requeueCalls.map((c) => c.rule)).toEqual([null, null]);
  });

  it("accepts a POST with NO body and no content-type — the bodyless all-rules arm", async () => {
    // `body: { required: false }` exists for this shape, and `post()` above
    // cannot reach it: it always sends a content-type and a serialized `{}`.
    // What zod-openapi actually does here is call `addValidatedData("json", {})`
    // — not leave the value `undefined`, which is what the route's comment used
    // to claim and what `admin-revoke.ts` records as a throw. Three recorded
    // beliefs, so the behaviour gets a test rather than a fourth comment.
    const res = await adminBrainTriage.request("/requeue", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requeued: 0, rule: null });
    expect(requeueCalls).toEqual([{ workspaceId: CURRENT_ORG, rule: null }]);
  });

  it("narrows to one rule and records that scope on the audit row", async () => {
    requeueResult = { requeued: 4 };
    const res = await post({ rule: "known_ack" });

    expect(await res.json()).toEqual({ requeued: 4, rule: "known_ack" });
    expect(requeueCalls).toEqual([{ workspaceId: CURRENT_ORG, rule: "known_ack" }]);
    expect(auditRows[0]?.metadata).toEqual({
      workspaceId: CURRENT_ORG,
      rule: "known_ack",
      requeued: 4,
    });
  });

  it("audits a run that moved nothing", async () => {
    // "An admin re-queued `known_ack` and nothing moved" is what makes a later
    // non-zero run interpretable; its absence would read as "nobody re-queued".
    const res = await post({ rule: "known_ack" });
    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.metadata).toMatchObject({ requeued: 0 });
  });

  it("400s an unknown rule instead of reporting a successful zero", async () => {
    const res = await post({ rule: "known_acks" });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_triage_rule");
    // The valid ids travel, so the fix is one read away rather than a guess.
    for (const id of TRIAGE_RULE_TUPLE) expect(body.message).toContain(id);
    // Nothing ran, and nothing was audited: a typo must not leave a row
    // claiming a scope the server never applied.
    expect(requeueCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("refuses a reader below the owner/admin bar without touching the store", async () => {
    memberRoleResult = "member";
    const res = await post({ rule: "known_ack" });
    expect(res.status).toBe(403);
    expect(requeueCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("400s without an active organization", async () => {
    ORG_ID = undefined;
    const res = await post({});
    expect(res.status).toBe(400);
    expect(requeueCalls).toEqual([]);
  });

  it("reports a COMMITTED re-queue when the audit row cannot be written", async () => {
    requeueResult = { requeued: 18 };
    auditThrows = new Error("admin_action_log unreachable");

    const res = await post({ rule: "known_ack" });
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("audit_write_failed");
    // The three things the admin needs and cannot get anywhere else: that it
    // landed, how many moved, and that a retry is not the fix — the marks are
    // already clear, so a second call would report 0 and read as a second
    // failure.
    expect(body.message).toContain("COMMITTED");
    expect(body.message).toContain("18");
    expect(body.message).toContain("Do not retry");
    // The write itself did happen — this is a reporting failure, not a rollback.
    expect(requeueCalls).toEqual([{ workspaceId: CURRENT_ORG, rule: "known_ack" }]);
  });

  it("does not audit a re-queue that failed before it committed", async () => {
    requeueThrows = new Error("internal db unavailable");
    const res = await post({});
    expect(res.status).toBe(500);
    // An audit row for an act that did not happen is worse than none: it is the
    // only record, so it would be read as authoritative.
    expect(auditRows).toEqual([]);
  });
});
