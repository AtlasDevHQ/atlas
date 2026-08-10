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
/** What `release()` was called WITH. `undefined` = pooled; an Error = destroyed. */
let releasedWith: unknown[] = [];
/** Saved so the suite leaves the environment as it found it. */
let priorInternalSecret: string | undefined;

const FAKE_CLIENT = {
  query: async (sql: string) => {
    statements.push(typeof sql === "string" ? sql : String(sql));
    if (sql === "ROLLBACK" && rollbackFailure !== null) throw rollbackFailure;
    // BEGIN and COMMIT always succeed: a failure there is a different test, and
    // one here would mask the arm under test.
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [], rowCount: 0 };
    if (queryFailure !== null) throw queryFailure;
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
}

const HANDLERS: Handler[] = [
  {
    name: "admin",
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
    releasedWith = [];
    statements = [];
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
