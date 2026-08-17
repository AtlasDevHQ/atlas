/**
 * The import seam's ERROR RESPONSES — both handlers (#5106, #5108).
 *
 * `admin-migrate.ts` ships the import twice: the admin route behind
 * `requireOrgContext`, and the internal service-to-service route behind
 * `ATLAS_INTERNAL_SECRET`. The two catch blocks are copies of each other, and
 * that duplication is the whole reason this file exists — every assertion below
 * runs against BOTH, because the realistic defect at this seam is a fix applied
 * to one handler and not the other.
 *
 * Two properties, neither of which had any coverage before:
 *
 *   - **A driver error's TEXT never reaches the response body** (#5106). A `pg`
 *     message is a fragment of the database, not a description of a failure: it
 *     embeds row content (`Key (id)=(…)`), internal constraint and column
 *     spellings, and on a connection failure the internal host and port. The
 *     500 carries a fixed generic message and the `requestId` as the handle.
 *   - **A REFUSAL is a 409, and its self-authored message IS echoed** (#5108).
 *     `RegionImportUnkeyableError` and `RegionImportVocabularyTargetError` name
 *     two different subsystems with two different remedies, and the `message` is
 *     the only thing that says which. A revert to the generic 500 — which is
 *     what #5047's commit message says was wrong — would be invisible without
 *     these.
 *
 * The two are asserted TOGETHER rather than in separate files on purpose: they
 * are the two arms of one `catch`, and the property that matters is the SPLIT.
 * A scrub applied to both arms closes the leak and destroys the refusal's
 * actionable text; a scrub applied to neither is today's bug. Only a test that
 * holds both ends sees that.
 *
 * ## How the error is injected, and why that is honest
 *
 * The fake client throws from `query`, so the error surfaces out of
 * `importBundle` exactly as a real one would. For the refusal cases that means
 * the error is RAISED somewhere other than `tombstonePlaceholder` — but what is
 * under test here is the catch's `instanceof` branch and the status it picks,
 * not where the throw originated. That `tombstonePlaceholder` raises these two
 * types on the right arms is pinned against real Postgres in
 * `lib/residency/__tests__/migrate-roundtrip-pg.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";
import type { ExportBundle } from "@useatlas/types";

const CURRENT_ORG = "org-1";
const INTERNAL_SECRET = "internal-secret-for-tests";

/**
 * What the next `client.query` throws, or `null` to let it succeed.
 *
 * Set per test. `importBundle` issues its first statement immediately, so this
 * is what a failure anywhere inside the import looks like from the handler.
 */
let queryFailure: Error | null = null;
/** Statements the fake client saw — `ROLLBACK` is asserted from here. */
let statements: string[] = [];

/**
 * When set, `ROLLBACK` itself throws this — the path where the handler cannot
 * know whether anything committed (#5106 round 2).
 */
let rollbackFailure: Error | null = null;
/** When set, `BEGIN` throws this — a socket that was dead before anything ran. */
let beginFailure: Error | null = null;
/**
 * When set, `COMMIT` throws this (#5112).
 *
 * The one failure that lets the whole import RUN and then keeps it from taking
 * effect — which is the input class the post-`COMMIT` refusal confirmation exists
 * to distinguish. Every other injection in this file fails before the vocabulary
 * merge, so none of them can tell "the confirmation is after COMMIT" from "the
 * confirmation is after the merge".
 */
let commitFailure: Error | null = null;
/** What `release()` was called WITH. `undefined` = pooled; an Error = destroyed. */
let releasedWith: unknown[] = [];
/** Saved so the suite leaves the environment as it found it. */
let priorInternalSecret: string | undefined;

/**
 * Rows the fake client answers for statements matching a substring (#5112).
 *
 * The default `{ rows: [] }` is right for the error cases above — nothing is ever
 * "already present" and the importer takes every INSERT path. It is NOT enough to
 * reach a vocabulary REFUSAL, which is a decision made from rows: the merge's
 * advisory-lock PROBE refuses to proceed unless it reads a count, and
 * `admitAliasEdge` refuses `already-aliased` only when it finds an existing edge.
 * So the refusal cases script exactly those two reads and nothing else.
 */
let rowResponders: Array<{ pattern: string; rows: Record<string, unknown>[] }> = [];

const FAKE_CLIENT = {
  query: async (sql: string) => {
    statements.push(typeof sql === "string" ? sql : String(sql));
    if (sql === "BEGIN" && beginFailure !== null) throw beginFailure;
    if (sql === "ROLLBACK" && rollbackFailure !== null) throw rollbackFailure;
    if (sql === "COMMIT" && commitFailure !== null) throw commitFailure;
    // Otherwise BEGIN/ROLLBACK/COMMIT succeed: a failure there is a different
    // test, and an unrequested one here would mask the arm under test.
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (queryFailure !== null) throw queryFailure;
    for (const responder of rowResponders) {
      if (sql.includes(responder.pattern)) {
        return { rows: responder.rows, rowCount: responder.rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  },
  release: (err?: unknown) => {
    releasedWith.push(err);
  },
};

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: async () => [] }),
  getInternalDB: () => ({ connect: async () => FAKE_CLIENT }),
}));

// Mock-ALL-exports (10 of them). A partial factory leaves the missing exports
// `undefined`, and the failure lands as `undefined is not a function` in an
// unrelated module one import away — the trap `alias-proposal-logging.test.ts`
// records at length.
const logged: { payload: unknown; message: string; level: "warn" | "error" }[] = [];
void mock.module("@atlas/api/lib/logger", () => {
  // ⚠️ THE LEVEL IS RECORDED, not merged. Two sinks bound to one array that
  // dropped the level is the same defect this branch fixed twice already
  // (`vocabulary-rekey-logging.test.ts`): the ROLLBACK line was deliberately
  // promoted warn -> error, and reverting it killed ZERO tests until this.
  const record = (level: "warn" | "error") => (payload: unknown, message?: unknown) =>
    logged.push({ payload, message: typeof message === "string" ? message : String(payload), level });
  const logger = {
    info: () => {},
    warn: record("warn"),
    error: record("error"),
    debug: () => {},
    level: "info",
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    setLogLevel: () => true,
    getRequestContext: () => ({ requestId: "test-req" }),
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    redactPaths: [] as string[],
    scrubErrSerializer: (err: unknown) => err,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  };
});

// Mock-ALL-exports again, and this file had been supplying 4 of the 8 — the
// same partial-factory trap its logger mock above is emphatic about. Harmless
// today only because `admin-migrate.ts` imports two of them; the day it reaches
// for `requirePermission`, the failure is `undefined is not a function` in a
// file with nothing to do with this one.
void mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  createPlatformRouter: () => new OpenAPIHono(),
  NO_ACTIVE_ORG_MESSAGE: "No active organization. Set an active org first.",
  NO_INTERNAL_DB_MESSAGE: "No internal database configured.",
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  enforcePermission: async () => {},
  noActiveOrgBody: (requestId: string) => ({
    error: "no_active_org",
    message: "No active organization. Set an active org first.",
    requestId,
  }),
  requireOrgContext:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ): Promise<void> => {
      c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
      c.set("requestId", "test-req");
      await next();
    },
}));

const {
  adminMigrate,
  internalMigrate,
  RegionImportUnkeyableError,
  RegionImportVocabularyTargetError,
  IMPORT_FAILED_MESSAGE,
} = await import("../admin-migrate");
// ⚠️ DYNAMIC, and it has to be. A STATIC import of `lib/brain/vocabulary` is hoisted
// above every `mock.module` call in this file, and that module calls `createLogger()`
// at MODULE SCOPE — so it binds the REAL logger and `mergeApprovedEdges`' per-refusal
// warn stops reaching `logged`. Measured: importing the cap statically made the
// per-refusal line invisible while every assertion still passed, because the
// post-COMMIT confirmation QUOTES the phrase `WILL DROP` and the lookup matched that
// instead. Same trap `cleanup.test.ts` documents from the other side.
const { VOCABULARY_REFUSAL_DETAIL_CAP } = await import("@atlas/api/lib/brain/vocabulary");

/**
 * A bundle `validateBundle` accepts that makes the importer ISSUE A STATEMENT.
 *
 * ⚠️ The one setting is load-bearing, not decoration. An all-empty bundle runs
 * `BEGIN`/`COMMIT` and nothing between them, so the injected failure never
 * fires and every assertion here passes against a 200 — the first cut of this
 * file did exactly that, and read as fifteen green tests of nothing.
 *
 * ⚠️ NO CAST. The return annotation is this fixture's ONLY compile-time check:
 * `validateBundle` is a hand-rolled shallow validator that tests top-level
 * array-ness and nothing else, so `as unknown as ExportBundle` (which the first
 * cut carried) would let the fixture go stale in silence the day `ExportBundle`
 * gains a required section — the suite would keep passing against a bundle the
 * importer rejects.
 */
function minimalBundle(): ExportBundle {
  return {
    manifest: {
      version: 1,
      exportedAt: "2026-08-10T00:00:00.000Z",
      source: { label: "self-hosted" },
      counts: { conversations: 0, messages: 0, semanticEntities: 0, learnedPatterns: 0, settings: 1 },
    },
    conversations: [],
    semanticEntities: [],
    learnedPatterns: [],
    settings: [{ key: "theme", value: "dark" }],
  };
}

interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly requestId: string;
}

/**
 * The two handlers, behind one calling convention.
 *
 * Every assertion runs over this list — which is what makes "both handlers" a
 * property of the suite rather than a discipline someone has to remember.
 */
interface Handler {
  readonly name: string;
  readonly post: (body: unknown) => Promise<Response>;
  /**
   * The correlation token this handler must use, where it has a request-scoped one.
   *
   * The admin route reads `c.get("requestId")`, which the mocked `requireOrgContext`
   * sets to a known value — so it is assertable. The internal route has no
   * middleware and mints its own `crypto.randomUUID()`, so there is nothing to
   * compare against and this stays `undefined`.
   */
  readonly expectedToken?: string;
}

const HANDLERS: Handler[] = [
  {
    name: "admin",
    expectedToken: "test-req",
    post: async (body: unknown) =>
      adminMigrate.request("/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  },
  {
    name: "internal (service-to-service)",
    post: async (body: unknown) =>
      internalMigrate.request("/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Atlas-Internal-Token": INTERNAL_SECRET,
        },
        body: JSON.stringify({ orgId: CURRENT_ORG, ...(body as Record<string, unknown>) }),
      }),
  },
];

describe("the import's error responses — both handlers", () => {
  beforeEach(() => {
    queryFailure = null;
    rollbackFailure = null;
    beginFailure = null;
    commitFailure = null;
    releasedWith = [];
    statements = [];
    rowResponders = [];
    logged.length = 0;
    priorInternalSecret = process.env.ATLAS_INTERNAL_SECRET;
    process.env.ATLAS_INTERNAL_SECRET = INTERNAL_SECRET;
  });

  // Restored rather than left set: the isolated runner contains the blast
  // radius, but every `-pg` sibling save/restores and a leaked secret env var
  // is the kind of cross-file coupling that is only ever debugged once.
  afterEach(() => {
    if (priorInternalSecret === undefined) delete process.env.ATLAS_INTERNAL_SECRET;
    else process.env.ATLAS_INTERNAL_SECRET = priorInternalSecret;
  });

  describe.each(HANDLERS)("$name handler", ({ post }) => {
    it("does NOT echo a driver error's text in the 500 body (#5106)", async () => {
      // The shape a real `pg` unique-violation takes, carrying the three things
      // that must never leave the process: ROW CONTENT, the internal constraint
      // spelling, and the column name.
      const leak =
        'duplicate key value violates unique constraint "brain_facts_pkey" ' +
        "Key (id)=(0f8c4a2e-1111-4000-8000-00000000dead) already exists.";
      queryFailure = new Error(leak);

      const res = await post(minimalBundle());
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorBody;

      expect(body.error).toBe("import_failed");
      // The whole message, and every distinctive fragment of it. Asserting the
      // full string alone would pass a body that appended the detail; asserting
      // the fragments alone would pass one that echoed a DIFFERENT driver
      // error. Both directions, because the leak is a substring problem.
      expect(body.message).not.toContain(leak);
      for (const fragment of [
        "duplicate key",
        "brain_facts_pkey",
        "Key (id)=",
        "0f8c4a2e-1111-4000-8000-00000000dead",
      ]) {
        expect(
          body.message.includes(fragment),
          `the 500 body echoed \`${fragment}\` from the driver's message — a pg error carries row ` +
            "content, internal constraint and column names, and on a connection failure the host " +
            "and port. CLAUDE.md § Product invariants: no secrets in responses.",
        ).toBe(false);
      }
      // …and it is not merely scrubbed to nothing: the caller still gets an
      // actionable message and the handle that reaches the detail.
      expect(body.message).toContain("rolled back");
      expect(body.message).toContain("requestId");
      expect(body.requestId).toBeTruthy();
    });

    it("a connection failure's host and port do not reach the body either (#5106)", async () => {
      // The second shape, and the one a scrub written against `Key (id)=` alone
      // would sail past: `pg` puts the internal host and port in the message
      // when the connection itself fails.
      queryFailure = new Error("connect ECONNREFUSED 10.4.19.221:5432");

      const res = await post(minimalBundle());
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorBody;

      expect(body.message).not.toContain("10.4.19.221");
      expect(body.message).not.toContain("5432");
      expect(body.message).not.toContain("ECONNREFUSED");
    });

    it("still records the driver error server-side, against the same requestId (#5106)", async () => {
      // ⚠️ THE OTHER HALF, and the half a fix for the leak most easily breaks:
      // scrubbing the response is only correct because the detail is MOVED, not
      // dropped. Without this assertion, "return a generic message" and "delete
      // the error handling" are the same green.
      const leak = 'null value in column "subject_key" violates not-null constraint';
      queryFailure = new Error(leak);

      const res = await post(minimalBundle());
      // Pinned, for the reason this file's own header records: the first cut
      // passed every body assertion against a 200.
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorBody;

      const recorded = logged.find(
        (entry) =>
          entry.message.includes("import failed") || entry.message.includes("Import failed"),
      );
      expect(recorded, "no log line recorded the failed import").toBeDefined();
      const payload = recorded?.payload as { err?: Error; requestId?: string };
      // The real Error instance, so pino's `err` serializer keeps the message
      // AND the stack — not a pre-stringified message that loses the stack.
      expect(payload.err).toBeInstanceOf(Error);
      expect(payload.err?.message).toBe(leak);
      // Same handle on both sides. This is what makes the requestId in the body
      // worth quoting: without it the operator holds a detail they cannot join
      // to the caller's complaint.
      expect(payload.requestId).toBe(body.requestId);
    });

    it("rolls back before responding, so the 500's promise is true", async () => {
      queryFailure = new Error("simulated 57014: statement cancelled");

      const res = await post(minimalBundle());
      expect(res.status).toBe(500);
      // The body says "all changes rolled back". Asserted rather than trusted,
      // because that sentence is the caller's basis for re-sending the bundle.
      expect(statements).toContain("ROLLBACK");
    });

    it.each([
      {
        label: "RegionImportUnkeyableError (a v3 bundle's key failed to arrive)",
        make: () =>
          new RegionImportUnkeyableError("0f8c4a2e-2222-4000-8000-000000000001", ["object"]),
      },
      {
        label: "RegionImportVocabularyTargetError (this region's vocabulary maps the norm away)",
        make: () =>
          new RegionImportVocabularyTargetError("0f8c4a2e-3333-4000-8000-000000000002", [
            "predicate",
          ]),
      },
    ])("maps $label to 409, echoing its self-authored message (#5108)", async ({ make }) => {
      const refusal = make();
      queryFailure = refusal;

      const res = await post(minimalBundle());

      // 409 rather than 400 (the request is well-formed — `validateBundle`
      // passed) and rather than 500 (nothing is broken, and retrying THIS body
      // can never succeed).
      expect(
        res.status,
        "a refusal fell back to the generic 500 — the status is what tells a caller that " +
          "re-sending cannot help, and #5047's whole point was that 500 was the wrong answer here",
      ).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error).toBe("import_refused");
      // VERBATIM, and this is the arm that must NOT be scrubbed. These two
      // errors author their own messages out of a fact UUID and position names
      // — no surfaces, no row content, no connection detail — and the message
      // is the only thing that names WHICH subsystem to fix. #5106's scrub
      // stops at the 500.
      expect(
        body.message,
        "the refusal's own message was replaced — the two refusal types name different " +
          "subsystems with different remedies, and the message is the only thing that says which",
      ).toBe(refusal.message);
      expect(body.requestId).toBeTruthy();
    });

    it("⭐ a FAILED rollback gets its own body — it never claims nothing was written", async () => {
      // ⚠️ THE assertion this round added. `IMPORT_FAILED_MESSAGE` promises
      // "nothing was written … re-sending the same bundle is safe". On this path
      // the handler issued a ROLLBACK and the request FAILED, so whether the
      // transaction aborted, is still open, or committed is unknown to it.
      //
      // Returning the confident sentence here is the same defect #5106 fixed one
      // layer up — a body asserting a state nobody established — and the
      // consequence is worse than the leak was: the leak exposed detail, this
      // would tell an operator to retry over a possibly-committed import.
      queryFailure = new Error("duplicate key value violates unique constraint");
      rollbackFailure = new Error("Connection terminated unexpectedly");

      const res = await post(minimalBundle());
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorBody;

      // A DISTINCT code, because callers branch on it and these two answers are
      // the furthest apart this endpoint gives.
      expect(
        body.error,
        "a failed rollback returned the ordinary `import_failed` code — a caller cannot tell " +
          "'retry is safe' from 'a human must inspect the destination'",
      ).toBe("import_rollback_uncertain");
      expect(body.message).toContain("UNKNOWN");
      expect(body.message).toContain("Do NOT re-send");
      // ⚠️ Compared against the CONSTANT, not a lowercase substring. The first
      // cut asserted `.not.toContain("re-sending the same bundle is safe")`
      // while the real text reads "Re-sending …" at a sentence start — so the
      // one assertion guarding "never promise retry-safety here" was inert
      // against the exact message it forbids.
      expect(body.message).not.toBe(IMPORT_FAILED_MESSAGE);
      expect(body.message.toLowerCase()).not.toContain("re-sending the same bundle is safe");
      // …and still no driver text, at either status.
      expect(body.message).not.toContain("duplicate key");
      expect(body.message).not.toContain("Connection terminated");
      expect(body.requestId).toBeTruthy();
    });

    it("⭐ DESTROYS the client when the rollback failed, instead of pooling it", async () => {
      // The corruption path, and why this is a defect rather than a wording nit.
      // `pg` destroys the socket when `release(err)` is called with a truthy
      // arg. Released bare, a client still inside an open transaction goes back
      // to the pool — and Postgres answers a second `BEGIN` on an open
      // transaction with a WARNING, not an error, so the next borrower's work
      // silently joins this failed import's transaction and ITS commit commits
      // the partial import, under a different requestId, minutes later.
      queryFailure = new Error("duplicate key value violates unique constraint");
      rollbackFailure = new Error("Connection terminated unexpectedly");

      await post(minimalBundle());

      expect(releasedWith).toHaveLength(1);
      expect(
        releasedWith[0],
        "the client was released bare after a FAILED rollback — it may still hold an open " +
          "transaction, and pooling it lets an unrelated later request commit this import",
      ).toBeInstanceOf(Error);
    });

    it("…and POOLS the client normally when the rollback succeeded", async () => {
      // The control, and it is not decoration: `release(err)` closes the socket,
      // so a handler that passed a truthy arg unconditionally would throw away a
      // healthy connection on every ordinary import failure — a fix that turns a
      // recoverable error into pool churn. Both directions, one pair.
      queryFailure = new Error("duplicate key value violates unique constraint");

      await post(minimalBundle());

      expect(releasedWith).toHaveLength(1);
      expect(
        releasedWith[0],
        "a healthy client was destroyed after a SUCCESSFUL rollback — release(err) closes the " +
          "socket, so this churns the pool on every ordinary import failure",
      ).toBeUndefined();
    });

    it("records the rollback failure server-side, with the workspace it may have corrupted", async () => {
      // The other half: the response says "inspect the destination", and this
      // line is what tells the operator WHICH destination. It is the one log
      // line naming a possibly-corrupted workspace, so `orgId` is not optional.
      queryFailure = new Error("duplicate key value violates unique constraint");
      rollbackFailure = new Error("Connection terminated unexpectedly");

      await post(minimalBundle());

      const rollbackLine = logged.find((entry) => entry.message.includes("ROLLBACK failed"));
      expect(rollbackLine, "a failed rollback left no log line").toBeDefined();
      const payload = rollbackLine?.payload as { err?: Error; orgId?: string; requestId?: string };
      expect(payload.err).toBeInstanceOf(Error);
      expect(payload.err?.message).toBe("Connection terminated unexpectedly");
      expect(payload.orgId, "the line that names a possibly-corrupted workspace omits it").toBe(
        CURRENT_ORG,
      );
      expect(payload.requestId).toBeTruthy();
      // ⚠️ `error`, not `warn`. This line says a pooled connection may be
      // poisoned and a transaction's fate is unknown; at `warn` it sits beside
      // routine noise. Unasserted, reverting the promotion killed no test.
      expect(
        rollbackLine?.level,
        "the rollback failure was logged below `error` — it reports a possibly-poisoned pooled " +
          "connection and an unknown transaction outcome",
      ).toBe("error");
    });

    it("⭐ a BEGIN that never succeeded is NOT uncertain — nothing could have been written", async () => {
      // ⚠️ `begun` is what makes the uncertain body honest in BOTH directions.
      // `pool.connect()` can hand back a dead socket: BEGIN throws, the catch's
      // ROLLBACK throws on the same socket, and `rollbackErr` is set — but
      // `importBundle` never ran, so nothing could have been written. Reporting
      // "inspect the destination workspace first" here sends a human to audit a
      // workspace on the one path where the answer is knowable.
      //
      // The log must agree with the body: round 3 keyed the message on
      // `rollbackErr` alone while the body used `rollbackErr && begun`, so this
      // case produced a log saying "the transaction's fate is unknown" beside a
      // body saying "all changes rolled back". Both now read one derived answer.
      beginFailure = new Error("Connection terminated unexpectedly");
      rollbackFailure = new Error("Connection terminated unexpectedly");

      const res = await post(minimalBundle());
      expect(res.status).toBe(500);
      const body = (await res.json()) as ErrorBody;
      expect(
        body.error,
        "a BEGIN that never resolved was reported as an uncertain outcome — nothing ran, so " +
          "`nothing was written` is established rather than assumed",
      ).toBe("import_failed");

      const failureLine = logged.find((e) => e.message.includes("import failed"));
      expect(
        (failureLine?.payload as { rolledBack?: boolean }).rolledBack,
        "the log and the body disagreed about the same transaction",
      ).toBe(true);
      // The client is still destroyed — the socket is untrustworthy either way.
      expect(releasedWith[0]).toBeInstanceOf(Error);
    });

    it("⭐ a REFUSAL whose rollback also failed is uncertain, NOT a confident 409", async () => {
      // ⚠️ The arm all three round-3 reviewers found, and the fifth appearance
      // of this branch's recurring shape. The refusal's own message ends
      // "re-export and re-run" and its OpenAPI description says NOTHING WAS
      // WRITTEN — both claims about the ROLLBACK, not about the error that
      // triggered it. And these refusals are raised in the brain-facts section,
      // AFTER conversations, entities, settings, dashboards, knowledge, tasks
      // and episodes have already inserted into the open transaction.
      //
      // So a refusal whose rollback failed is the uncertain state exactly, and
      // a confident 409 tells the operator to re-send over a possibly-committed
      // partial import. The uncertainty check therefore sits ABOVE the 409 arm.
      queryFailure = new RegionImportUnkeyableError("0f8c4a2e-5555-4000-8000-000000000005", [
        "object",
      ]);
      rollbackFailure = new Error("Connection terminated unexpectedly");

      const res = await post(minimalBundle());
      const body = (await res.json()) as ErrorBody;

      expect(
        res.status,
        "a refusal whose ROLLBACK failed was answered 409 — that status's contract says nothing " +
          "was written, which is a claim about the rollback the process just failed to make",
      ).toBe(500);
      expect(body.error).toBe("import_rollback_uncertain");
      expect(body.message).toContain("Do NOT re-send");
      // The client is destroyed here too — the session is untrustworthy
      // regardless of which error diagnosed the failure.
      expect(releasedWith[0]).toBeInstanceOf(Error);
    });

    it("…and a refusal whose rollback SUCCEEDED is still a clean 409", async () => {
      // The control for the hoist. Checking `rollbackErr` first is correct only
      // if it does not swallow the ordinary refusal — the whole point of #5047's
      // 409 is that a well-diagnosed refusal keeps its actionable message.
      queryFailure = new RegionImportUnkeyableError("0f8c4a2e-6666-4000-8000-000000000006", [
        "object",
      ]);

      const res = await post(minimalBundle());
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error).toBe("import_refused");
      expect(body.message).toContain("0f8c4a2e-6666-4000-8000-000000000006");
    });

    it("a refusal and a driver error do not converge on one body", async () => {
      // The falsifier for the split itself. A fix that scrubbed BOTH arms — the
      // obvious over-correction for #5106 — passes every leak assertion above
      // and every status assertion beside it, and is caught only by comparing
      // the two bodies.
      queryFailure = new RegionImportUnkeyableError("0f8c4a2e-4444-4000-8000-000000000003", [
        "subject",
      ]);
      const refused = (await (await post(minimalBundle())).json()) as ErrorBody;

      queryFailure = new Error("duplicate key value violates unique constraint");
      const failed = (await (await post(minimalBundle())).json()) as ErrorBody;

      expect(refused.message).not.toBe(failed.message);
      // The refusal names the row it refused on; the generic never names
      // anything the caller did not already send.
      expect(refused.message).toContain("0f8c4a2e-4444-4000-8000-000000000003");
      expect(failed.message).not.toContain("0f8c4a2e-4444-4000-8000-000000000003");
    });
  });


  // ── #5112 — the post-COMMIT "DID DROP" confirmation, both handlers ──
  //
  // `mergeApprovedEdges` emits one FUTURE-TENSE warn per refusal, and that tense
  // is correct: the merge is section 9 of ~13 inside the transaction, so the
  // closure rebuild, the brain's identity refusal or any driver error can still
  // roll the whole import back — and then no edge was dropped because none was
  // applied. The cost of being correct there is that nothing ever said the drop
  // HAPPENED, so an operator following the recovery path could not tell a
  // committed loss from a rolled-back attempt whose retry succeeded.
  //
  // Asserted over BOTH handlers, for this file's founding reason: the two
  // post-COMMIT blocks are copies, so the realistic defect is a line added to one.

  /**
   * Make the merge REFUSE one arriving edge.
   *
   * Two scripted reads and no more. The advisory-lock probe must answer a count
   * or the merge refuses to run at all (it cannot verify it holds the lock), and
   * `admitAliasEdge`'s first SELECT must find an existing edge onto a DIFFERENT
   * target — same target is a `duplicate`, which is the benign half and no
   * refusal at all.
   */
  function scriptOneRefusal(): void {
    rowResponders = [
      { pattern: "pg_locks", rows: [{ n: 1 }] },
      { pattern: "SELECT to_norm FROM brain_vocabulary_edge", rows: [{ to_norm: "cost" }] },
    ];
  }

  /**
   * A bundle `validateBundle` accepts that carries `count` alias edges.
   *
   * Distinct `fromNorm`s, because `validateBundle` refuses an empty norm and a
   * self-edge and the merge would otherwise count duplicates rather than refusals.
   */
  function bundleWithEdges(count: number): ExportBundle {
    return {
      ...minimalBundle(),
      brainVocabularyEdges: Array.from({ length: count }, (_, i) => ({
        slotPosition: "predicate",
        fromNorm: `price ${i}`,
        toNorm: "priced at",
        approvedBy: "source-admin",
        approvedAt: "2026-06-01T00:00:00.000Z",
      })),
    };
  }

  const bundleWithOneEdge = (): ExportBundle => bundleWithEdges(1);

  const CONFIRMATION = "Vocabulary merge DID DROP";
  /**
   * The per-refusal, future-tense line from `mergeApprovedEdges`.
   *
   * ⚠️ NOT `"WILL DROP"`, which is what this started as and which matched the
   * CONFIRMATION — that message quotes the phrase ("Every preceding 'WILL DROP' line
   * carrying this correlationId is now a fact"), so the lookup found the confirmation,
   * the join-key assertion compared the confirmation to itself, and both passed while
   * the per-refusal line was absent entirely. A lexical matcher cannot tell a
   * quotation from the thing it quotes; this one matches wording only the real line
   * has.
   */
  const WILL_DROP = "WILL DROP an arriving alias edge";

  describe.each(HANDLERS)("$name handler — refusal confirmation", ({ post, expectedToken }) => {
    it("⭐ warns DID DROP after COMMIT, carrying the payloads and the requestId", async () => {
      scriptOneRefusal();

      const res = await post(bundleWithOneEdge());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        brainVocabularyEdges: { refused: number; refusalDetails: unknown[] };
      };

      // Premise guard: the test is vacuous unless an edge really was refused. The
      // first cut of the scripting above returned no rows and every assertion
      // below passed against `refused: 0`.
      expect(body.brainVocabularyEdges.refused).toBe(1);
      expect(body.brainVocabularyEdges.refusalDetails).toHaveLength(1);

      // `COMMIT` ran at all. ⚠️ THIS IS A PRESENCE CHECK, NOT A POSITION CHECK, and
      // an earlier version of this comment claimed otherwise — `statements` and
      // `logged` are unrelated arrays with no interleaving, so moving the
      // confirmation one line ABOVE the `COMMIT` passes this outright. The position
      // is guarded by the `commitFailure` case at the end of this block, which is
      // the only injection that lets the merge run and then keeps the transaction
      // from taking effect.
      expect(statements).toContain("COMMIT");

      const confirmation = logged.find((l) => l.message.includes(CONFIRMATION));
      expect(confirmation).toBeDefined();
      // `warn`, not `info`: dropping a human's approved decision is not routine.
      // The level travels with the payload here for that reason.
      expect(confirmation?.level).toBe("warn");
      expect(confirmation?.payload).toMatchObject({
        refused: 1,
        detailsCarried: 1,
        // Asserted, because it was in the payload and pinned by nothing — and the
        // whole reason it is there is to make a `detailsCarried` short of `refused`
        // legible rather than looking like an inconsistency.
        detailCap: VOCABULARY_REFUSAL_DETAIL_CAP,
      });
      // The token is asserted as a JOIN KEY below rather than as a literal, because
      // the two handlers mint it differently and both are correct: the admin route
      // reads `c.get("requestId")`, while the internal route has no middleware and
      // mints its own `crypto.randomUUID()`. What must hold in both is that it is a
      // real value and that the same one appears on the WILL-DROP line.
      const token = (confirmation?.payload as { correlationId: unknown }).correlationId;
      expect(typeof token).toBe("string");
      expect(token).not.toBe("");
      // The payloads are REPEATED rather than referenced: the per-refusal warns
      // and this line can be separated by minutes of unrelated traffic, and a
      // confirmation saying "the lines above are real" is unreadable once they
      // are not above it.
      expect(
        (confirmation?.payload as { refusalDetails: Array<{ existingTarget: string }> })
          .refusalDetails[0].existingTarget,
      ).toBe("cost");

      // ⚠️ THE JOIN KEY. The same token appears on the per-refusal WILL-DROP line,
      // which is what converts that line's future tense into a fact. Without this
      // the confirmation is a second, unrelated line about the same event.
      const willDrop = logged.find((l) => l.message.includes(WILL_DROP));
      expect(willDrop).toBeDefined();
      expect((willDrop?.payload as { correlationId: unknown }).correlationId).toBe(token);

      // ⚠️ AND, where the handler has one, the token IS the request's own id. Asserted
      // per-handler rather than globally because the two mint differently and both are
      // correct — but "a non-empty string that joins to WILL DROP" is satisfied by a
      // freshly-minted UUID that correlates to NOTHING else in the request, which
      // would silently break the join to the 500 body's `requestId` and to every
      // other line the request emits.
      if (expectedToken !== undefined) expect(token).toBe(expectedToken);
    });

    it("⭐ CAPS the payloads it carries, and reports both numbers", async () => {
      // `detailsCarried === refused` in the case above, which is the accidental
      // equality that makes `detailsCarried: refused` an invisible mutation — and the
      // route's own comment says naming both numbers is the point precisely BECAUSE
      // they can differ. Here they must: one more edge than the cap.
      const over = VOCABULARY_REFUSAL_DETAIL_CAP + 1;
      scriptOneRefusal();

      const res = await post(bundleWithEdges(over));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        brainVocabularyEdges: { refused: number; refusalDetails: unknown[] };
      };

      // Every edge refused (the scripted read answers `already-aliased` for all of
      // them), and the response carries only the cap's worth.
      expect(body.brainVocabularyEdges.refused).toBe(over);
      expect(body.brainVocabularyEdges.refusalDetails).toHaveLength(
        VOCABULARY_REFUSAL_DETAIL_CAP,
      );

      const confirmation = logged.find((l) => l.message.includes(CONFIRMATION));
      expect(confirmation?.payload).toMatchObject({
        refused: over,
        detailsCarried: VOCABULARY_REFUSAL_DETAIL_CAP,
        detailCap: VOCABULARY_REFUSAL_DETAIL_CAP,
      });
      // The two numbers DIFFER, which is the property this case exists for.
      expect(over).not.toBe(VOCABULARY_REFUSAL_DETAIL_CAP);
    });

    it("⭐ says NOTHING when no edge was refused", async () => {
      // The other input class at the same guard. A confirmation that fired on
      // every import carrying a vocabulary would train an operator to skip the
      // line, which is the alarm fatigue the source-side disclosure already
      // guards against — and deleting `if (refused === 0) return` is the mutation
      // this catches.
      rowResponders = [{ pattern: "pg_locks", rows: [{ n: 1 }] }];

      const res = await post(bundleWithOneEdge());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { brainVocabularyEdges: { refused: number } };
      // Premise guard the other way: the edge was APPLIED, so there was a
      // vocabulary section and it produced no refusal.
      expect(body.brainVocabularyEdges.refused).toBe(0);

      expect(logged.filter((l) => l.message.includes(CONFIRMATION))).toEqual([]);
      expect(logged.filter((l) => l.message.includes(WILL_DROP))).toEqual([]);
    });

    it("⭐ says nothing when the COMMIT itself failed — a rollback dropped nothing", async () => {
      // The load-bearing negative, and the ONLY injection in this file that can
      // make it: the whole import runs, the refusal is computed, the WILL-DROP line
      // is emitted — and then `COMMIT` throws, so no edge was dropped because none
      // was applied. A confirmation here would send an operator to re-author
      // decisions that are still in the source region.
      //
      // A failure earlier in the transaction could not test this: the merge would
      // never run, so a confirmation placed right after the merge — the defect —
      // would stay silent for the wrong reason and the test would pass.
      scriptOneRefusal();
      commitFailure = new Error("connection terminated during COMMIT");

      const res = await post(bundleWithOneEdge());
      expect(res.status).toBe(500);

      // The merge DID run and DID decide — that is what makes the silence below a
      // property of the confirmation's position rather than of the merge's.
      expect(logged.some((l) => l.message.includes(WILL_DROP))).toBe(true);
      expect(logged.filter((l) => l.message.includes(CONFIRMATION))).toEqual([]);
    });
  });

  it("both handlers return the SAME generic 500 message", async () => {
    // The duplication assertion, and the reason #5106 names it: the two catch
    // blocks are copies, so the realistic defect is a fix that lands in one.
    // Sharing one constant is what makes that structurally impossible — this
    // test is what says the sharing is still in force.
    queryFailure = new Error("duplicate key value violates unique constraint");
    const [admin, internal] = await Promise.all(
      HANDLERS.map(async ({ post }) => {
        const res = await post(minimalBundle());
        expect(res.status).toBe(500);
        return ((await res.json()) as ErrorBody).message;
      }),
    );

    expect(admin).toBe(internal);
  });
});
