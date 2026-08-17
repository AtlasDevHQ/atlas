/**
 * The purge's abort LOG lines (#5265 review).
 *
 * Why these live in their own file rather than beside the other
 * `hardDeleteWorkspace` tests: `internal.test.ts` deliberately uses no
 * `mock.module` at all — only `_resetPool` — and mocking the logger is
 * file-global under bun, so adding it there would put a partial mock in front of
 * every other test in that file. A separate file is the cheap way to get the assertion
 * without that blast radius.
 *
 * ⚠️ REQUIRES THE ISOLATED RUNNER, which is the repo's mandated invocation
 * (`bun run test` / `scripts/test-isolated.ts`, never a bare `bun test` across
 * files). `mock.module` only takes effect if it runs BEFORE the module is
 * evaluated, which is why `../internal` is imported dynamically below. A sibling
 * file that imports it statically wins the race when both share one process:
 * `createLogger()` has already been called at module init, so `log` is the real
 * logger and every assertion here goes red. Measured both directions — combined,
 * whichever file loads second loses; per-file, 112 + 4 green. Env and pool state
 * are torn down per TEST for the same reason.
 *
 * ⚠️ WHAT THESE PIN, AND WHY IT IS NOT COSMETIC. #5265 made a database abort
 * answer 409 instead of 500. That is the right status — `classifyError` replaces
 * the message of a 5xx domain error with an opaque reference, which is the whole
 * defect the change removes — but it means the HTTP status no longer says
 * "something went wrong here", so **`log.error` is the only machine-readable
 * signal that a GDPR purge failed**. Anything keyed on 5xx-rate for this endpoint
 * went dark.
 *
 * A compensating control with no test is one refactor away from being deleted as
 * noise, and the round-2 review flagged exactly that: the catch's `log.error`/
 * `log.warn` calls had no falsifier, so removing any of them was green across every
 * suite. This file pins all four in the catch — the 42P01 arm, the two abort arms,
 * and the failed-ROLLBACK warning — plus two outside it: the racing-admin refusal
 * and the tombstone-attribution warning.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";

interface CapturedLog {
  level: "error" | "warn" | "info" | "debug";
  fields: Record<string, unknown>;
  message: string;
}

let captured: CapturedLog[] = [];
/** Every statement the client was asked to run — the ROLLBACK count is a fact about SQL, not about logs. */
let issued: string[] = [];

/**
 * Each level pushes its own tag.
 *
 * ⚠️ The LEVEL travels with the payload deliberately. A sink that funnels every
 * level into one array cannot see a `log.error` demoted to `log.warn` — measured
 * as a real class in this repo (#5110, three files) — and on this path the level
 * IS part of the claim: an aborted erasure is an error, not a warning.
 */
const record = (level: CapturedLog["level"]) =>
  mock((fields: unknown, message?: unknown) => {
    captured.push({
      level,
      fields: (typeof fields === "object" && fields !== null ? fields : {}) as Record<string, unknown>,
      message: typeof message === "string" ? message : "",
    });
  });

const logger = {
  error: record("error"),
  warn: record("warn"),
  info: record("info"),
  debug: record("debug"),
};

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => logger,
  log: logger,
}));

const { hardDeleteWorkspace, _resetPool } = await import("../internal");

/**
 * The abort's code, structurally.
 *
 * `PurgeAbortedError` arrives through a DYNAMIC import — the module has to be
 * loaded after `mock.module` patches the logger — so the binding is a value and
 * cannot be used as a type. Reading `.code` off this shape is all these tests
 * need, and it keeps the load order (which is the point of the file) intact.
 */
type AbortShape = { readonly code: string };

/**
 * ⚠️ SAVED AND RESTORED, not just set. `beforeEach` writes `DATABASE_URL` so
 * `getInternalDB()` accepts the stub pool, and leaving it set leaks into any
 * sibling file sharing the process: measured, it turned four `hasInternalDB()` /
 * `getInternalDB()` tests in `internal.test.ts` red when the two files were run in
 * one `bun test` invocation. The repo's isolated runner (`bun run test`) would
 * have hidden that, which is exactly why the discipline is per-file
 * self-containment rather than per-runner luck.
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

afterAll(() => {
  _resetPool(null);
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

/** A pool whose client fails where the caller asks it to. */
function poolThatFails(
  failWith: unknown,
  opts: { failOn: "first-delete" | "commit"; rollbackFails?: boolean },
) {
  let thrown = false;
  const client = {
    async query(sql: string) {
      issued.push(sql);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("SELECT WORKSPACE_STATUS")) {
        return { rows: [{ workspace_status: "deleted" }] };
      }
      if (sql.includes("to_regclass")) return { rows: [{ table_exists: true }] };
      if (sql.includes("FROM member m")) return { rows: [] };
      if (sql.includes("WITH ids AS")) {
        return { rows: [{ removed_count: 1, tombstoned_ids: ["sub_x"] }] };
      }
      if (opts.failOn === "commit" && upper === "COMMIT") throw failWith;
      if (upper === "ROLLBACK") {
        if (opts.rollbackFails) throw new Error("ROLLBACK failed — socket dirty");
        return { rows: [] };
      }
      if (!thrown && opts.failOn === "first-delete" && upper.startsWith("DELETE")) {
        thrown = true;
        throw failWith;
      }
      if (upper.startsWith("DELETE") || upper.startsWith("INSERT")) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() {
      return client;
    },
    async query() {
      return { rows: [] };
    },
    async end() {},
    on() {},
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
}

const errorsFor = (substring: string): CapturedLog[] =>
  captured.filter((c) => c.level === "error" && c.message.includes(substring));

describe("hardDeleteWorkspace abort logging (#5265)", () => {
  beforeEach(() => {
    captured = [];
    issued = [];
    process.env.DATABASE_URL = "postgres://stub/stub";
  });

  // Torn down per TEST, not per file. `afterAll` was not enough: the injected pool
  // and the stub `DATABASE_URL` are both module-level state on the SAME `internal`
  // instance a sibling file imports, so anything sharing the process saw them for
  // the whole of this file's run rather than just after it.
  afterEach(() => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("logs a DATABASE abort at error level with the orgId and the SQLSTATE", async () => {
    // The compensating control for the 500 -> 409 downgrade. Without this line an
    // aborted GDPR purge is invisible to anything keyed on 5xx, which is now
    // everything: the response is a 409, and `classifyError` does not log a 4xx
    // domain error (nor does `app.onError`, which forwards the HTTPException
    // first).
    _resetPool(
      poolThatFails(Object.assign(new Error("deadlock detected"), { code: "40P01" }), {
        failOn: "first-delete",
      }) as never,
    );

    const err = await hardDeleteWorkspace("org-log-1").catch((e: unknown) => e);
    expect((err as AbortShape).code).toBe("purge_rolled_back");

    const logged = errorsFor("aborted on a database error");
    expect(logged, "the only signal that a GDPR purge aborted was not emitted").toHaveLength(1);
    expect(logged[0].fields.orgId).toBe("org-log-1");
    expect(logged[0].fields.code).toBe("40P01");
    // The pg message goes to the LOG precisely because it is withheld from the
    // response — if it were absent from both, the redaction would have destroyed
    // the diagnosis rather than relocated it.
    expect(logged[0].fields.err).toContain("deadlock detected");
  });

  it("logs the REGION-DRIFT abort, whose remedy is the one that cannot be re-run", async () => {
    // The 42P01 arm. Worth its own case because its remedy differs from every other
    // arm's — "run this region's migrations", not "re-run the endpoint" — so a
    // reader of the log needs to see which arm fired, not just that one did.
    _resetPool(
      poolThatFails(Object.assign(new Error('relation "brain_facts" does not exist'), { code: "42P01" }), {
        failOn: "first-delete",
      }) as never,
    );

    const err = await hardDeleteWorkspace("org-log-5").catch((e: unknown) => e);
    expect((err as AbortShape).code).toBe("region_schema_behind");

    const logged = errorsFor("missing relation or column");
    expect(logged).toHaveLength(1);
    expect(logged[0].fields.orgId).toBe("org-log-5");
    expect(logged[0].fields.code).toBe("42P01");
  });

  it("warns when the ROLLBACK itself fails, because the client is then destroyed", async () => {
    // The fourth catch log. Distinct consequence from the others: a failed ROLLBACK
    // means the socket is dirty, so `client.release(rollbackErr)` DESTROYS the
    // connection rather than returning it to the pool. Without this line the only
    // record of a discarded connection is the pool's own metrics.
    _resetPool(
      poolThatFails(Object.assign(new Error("deadlock detected"), { code: "40P01" }), {
        failOn: "first-delete",
        rollbackFails: true,
      }) as never,
    );

    const err = await hardDeleteWorkspace("org-log-6").catch((e: unknown) => e);
    // Still a determinate rollback: COMMIT was never issued, so nothing landed
    // whatever the ROLLBACK did.
    expect((err as AbortShape).code).toBe("purge_rolled_back");

    const warned = captured.filter(
      (c) => c.level === "warn" && c.message.includes("ROLLBACK failed after purge transaction error"),
    );
    expect(warned, "a destroyed connection left no record").toHaveLength(1);
    expect(warned[0].fields.orgId).toBe("org-log-6");
    expect(warned[0].fields.err).toContain("socket dirty");
  });

  it("logs an INDETERMINATE outcome at error level, naming both deciding facts", async () => {
    _resetPool(
      poolThatFails(new Error("Connection terminated unexpectedly"), { failOn: "commit" }) as never,
    );

    const err = await hardDeleteWorkspace("org-log-2").catch((e: unknown) => e);
    expect((err as AbortShape).code).toBe("purge_outcome_unknown");

    const logged = errorsFor("INDETERMINATE outcome");
    expect(logged).toHaveLength(1);
    expect(logged[0].fields.orgId).toBe("org-log-2");
    // Both facts the arm keys on, so a reader of the log can reconstruct WHY the
    // outcome was called unknowable rather than taking the message's word for it.
    expect(logged[0].fields.commitAttempted).toBe(true);
    expect(logged[0].fields.rollbackFailed).toBe(false);
  });

  it("logs the racing-admin refusal, which reaches the wire as an otherwise-silent 409", async () => {
    // This abort had NO log at any level: it is a 4xx domain error, so
    // `classifyError` skips it and `app.onError` forwards the HTTPException before
    // its own `log.error`; and `logAdminAction` runs only on the success path, so
    // it was not in `admin_action_log` either. A concurrent operator action on a
    // GDPR purge left no server-side record that anyone tried.
    const client = {
      async query(sql: string) {
        issued.push(sql);
        if (sql.trim().toUpperCase().startsWith("SELECT WORKSPACE_STATUS")) {
          return { rows: [{ workspace_status: "active" }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    _resetPool({
      async connect() {
        return client;
      },
      async query() {
        return { rows: [] };
      },
      async end() {},
      on() {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as never);

    const err = await hardDeleteWorkspace("org-log-3").catch((e: unknown) => e);
    expect((err as AbortShape).code).toBe("not_soft_deleted");

    const logged = captured.filter((c) => c.message.includes("reactivated (or removed) after the route pre-check"));
    expect(logged, "a lost purge race left no server-side record at all").toHaveLength(1);
    expect(logged[0].level).toBe("warn");
    expect(logged[0].fields.orgId).toBe("org-log-3");
    expect(logged[0].fields.status).toBe("active");
    // ⚠️ Exactly ONE ROLLBACK, counted as SQL rather than inferred from a log.
    // The first version of this assertion checked that no "ROLLBACK failed" line
    // was emitted — which cannot fail here, because this fixture's ROLLBACK
    // SUCCEEDS, so restoring the double rollback was green. Counting the statements
    // is what makes it falsifiable.
    //
    // What the second ROLLBACK cost: a no-transaction-in-progress WARNING on the
    // server for every purge race, and — if the FIRST one failed — a second log
    // line reading "ROLLBACK failed after purge transaction error", misattributing
    // the cause to a query fault rather than to this guard.
    expect(
      issued.filter((sql) => sql.trim().toUpperCase() === "ROLLBACK"),
      "the guard and the closing catch are both rolling back — one transaction, one ROLLBACK",
    ).toHaveLength(1);
  });
  it("warns when the tombstone RETURNING yields values that are not ids", async () => {
    // ⚠️ The filter that keeps `tombstoned_ids` type-safe also made a renamed
    // RETURNING column indistinguishable from "this workspace had no
    // subscriptions" — both produce `[]`. That is deleting the signal in the name
    // of guarding it, and it matters because this log line is the ONLY attribution
    // of which workspace stamped a tombstone that will ever exist:
    // `stripe_purged_subscriptions` has no org column, and a tombstone
    // permanently suppresses webhook processing for the id.
    const client = {
      async query(sql: string) {
        const upper = sql.trim().toUpperCase();
        if (upper.startsWith("SELECT WORKSPACE_STATUS")) {
          return { rows: [{ workspace_status: "deleted" }] };
        }
        if (sql.includes("to_regclass")) return { rows: [{ table_exists: true }] };
        if (sql.includes("FROM member m")) return { rows: [] };
        // Two ids returned, neither a string — the shape a renamed RETURNING
        // column produces. (One ROW, whose `tombstoned_ids` array holds two
        // non-string elements; the warning counts the ids, not the rows.)
        if (sql.includes("WITH ids AS")) {
          return { rows: [{ removed_count: 2, tombstoned_ids: [7, 8] }] };
        }
        if (upper.startsWith("DELETE") || upper.startsWith("INSERT")) return { rows: [{ ok: 1 }] };
        return { rows: [] };
      },
      release() {},
    };
    _resetPool({
      async connect() {
        return client;
      },
      async query() {
        return { rows: [] };
      },
      async end() {},
      on() {},
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as never);

    // The purge still COMPLETES — an unusable attribution is a reporting problem,
    // not a reason to refuse an erasure.
    const result = await hardDeleteWorkspace("org-log-4");
    expect(result.counts.stripeWebhookEvents).toBe(2);

    const warned = captured.filter(
      (c) => c.level === "warn" && c.message.includes("Tombstone RETURNING produced values that were not strings"),
    );
    expect(warned, "a broken attribution was silently reported as an empty one").toHaveLength(1);
    expect(warned[0].fields.returned).toBe(2);
    expect(warned[0].fields.usable).toBe(0);
  });
});
