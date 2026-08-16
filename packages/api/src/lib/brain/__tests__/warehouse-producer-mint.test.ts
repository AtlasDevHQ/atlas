/**
 * The production mint's BY-REFERENCE contract (#5230).
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **Generated — see `packages/api/scripts/mutations/warehouse-producer.md`**, where
 * this file is the `mint` column (#5229). It is 0 on every row except the two that
 * edit `defaultValidateSnapshotSql` itself, because it never calls
 * `runWarehouseProducer` — that narrowness is the point of the file, not a gap.
 * Deleting the production gate kills BOTH tests here, which trips the runner's
 * whole-suite flag; the spec's note explains why that is honest for a two-test
 * single-subject file rather than the setup breakage the flag usually means.
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/warehouse-producer.mutations.ts
 *
 * ## Why this needs its own file
 *
 * `runWarehouseProducer` refuses unless `verdict.request === request` — the
 * anti-replay check. The only production mint is `defaultValidateSnapshotSql`, and
 * nothing asserted that it brands the request it was HANDED rather than a copy of
 * it. Measured: replacing that with `{ ...request }` fails only this suite — the
 * unit, logging and bypass suites stay green — while in production every entity is
 * refused on every run as an "Atlas wiring fault". The producer silently stops
 * emitting and the Atlas goes stale.
 *
 * The unit suite cannot cover it. Its real-gate block drives the shipped
 * `defaultValidateSnapshotSql` for real, but the gate's table check is
 * workspace-whitelist-scoped and a test workspace has none — so that block only ever
 * reaches the REFUSING arm, and the refusing arm carries no request. The passing arm
 * is only reachable with the gate itself stubbed, which means `mock.module`, whose
 * blast radius is the PROCESS rather than the file — so this suite must not share one
 * with `warehouse-producer.test.ts`'s real-gate block, the very block whose docstring
 * records that deleting the production gate used to leave every suite green. The
 * isolated runner spawns per file, so CI is safe; a hand-run `bun test <a> <b>` is
 * not, and the `afterAll` below is what makes a leak benign rather than silent.
 *
 * ⚠️ EVERY value export of `lib/tools/sql` is replaced below. `mock.module` swaps the
 * whole module, so an export left out becomes `undefined` and the first unrelated
 * consumer throws — which reads as a broken test rather than a missing mock.
 *
 * ⚠️ **What this file does NOT pin: the brand.** Retype the passing arm's `request`
 * to the bare request type and every assertion here still compiles and passes. That
 * half is carried by the `@ts-expect-error` rows in `warehouse-producer.test.ts`, and
 * the two files can be edited independently — hence the pointer.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

let validateSqlCalls: { sql: string; connectionId?: string; workspaceId?: string }[] = [];
let nextResult: { valid: boolean; error?: string } = { valid: true };

void mock.module("@atlas/api/lib/tools/sql", () => ({
  MAX_SQL_LEN: 100_000,
  extractClassification: () => undefined,
  parserDatabase: () => "postgresql",
  validateSQL: async (sql: string, connectionId?: string, workspaceId?: string) => {
    validateSqlCalls.push({ sql, connectionId, workspaceId });
    return nextResult;
  },
  buildSqlExecuteSpanAttrs: () => ({}),
  runSqlPipelineEffect: () => {
    throw new Error("not used by this suite");
  },
  runUserQueryPipeline: async () => {
    throw new Error("not used by this suite");
  },
  executeSQL: {},
}));

type ProducerModule = typeof import("@atlas/api/lib/brain/warehouse-producer");
type WarehouseSnapshotRequest =
  import("@atlas/api/lib/brain/warehouse-producer").WarehouseSnapshotRequest;

let producer: ProducerModule;

beforeAll(async () => {
  // DYNAMIC, after the mock is installed — a static import binds the real
  // `validateSQL` at module-evaluation time and this suite would drive the shipped
  // gate against a workspace with no whitelist, i.e. the refusing arm forever.
  producer = await import("@atlas/api/lib/brain/warehouse-producer");
});

afterAll(() => {
  // ⚠️ `mock.module` is PROCESS-wide, not file-wide. `scripts/test-isolated.ts`
  // spawns per file so CI is unaffected, but `bun test <a> <b>` — the invocation
  // CLAUDE.md permits for single files — shares one process. Resetting cannot
  // uninstall the mock. Since #5230 `warehouse-producer.test.ts`'s real-gate block
  // carries a positive tripwire on the shipped gate's own wording, so a co-run REDS
  // there rather than passing against this stub — measured, and its docstring says
  // so. The reset only keeps the leaked state predictable; the red is that file's
  // job, not this one's.
  nextResult = { valid: true };
  validateSqlCalls = [];
});

/**
 * ⚠️ A NON-DEFAULT `connectionId`, and it is load-bearing.
 *
 * With `undefined` here, `toEqual` ignores the key and the "it validated THIS
 * statement" assertion below is blind to the argument being dropped — measured:
 * passing a literal `undefined` as `validateSQL`'s second argument left this suite
 * green. That argument resolves the dialect the parser runs in (`tools/sql.ts` calls
 * the wrong mode a security risk) and scopes the whitelist, while
 * `defaultRunSnapshot` reads the row set from `connectionId ?? "default"` — so
 * dropping it validates against one connection and reads from another.
 */
const REQUEST: WarehouseSnapshotRequest = {
  workspaceId: "ws-5230-mint",
  entity: "Accounts",
  connectionId: "warehouse-replica",
  sql: "SELECT account_id AS atlas_brain_subject FROM accounts LIMIT 101",
};

describe("defaultValidateSnapshotSql", () => {
  test("brands the request it was handed — BY REFERENCE, not a copy", async () => {
    validateSqlCalls = [];
    nextResult = { valid: true };

    const verdict = await producer.defaultValidateSnapshotSql(REQUEST);

    expect(verdict.valid).toBe(true);
    if (!verdict.valid) throw new Error("the stubbed gate said yes; the mint refused");
    // ⚠️ `toBe`, deliberately, and this is the whole point of the file. `toEqual`
    // passes against `{ ...request }` — the edit that fail-closes production — so a
    // deep-equality assertion here would certify exactly the defect it exists for.
    // Upcast so the comparison is at the request type; the brand is compile-time.
    const branded: WarehouseSnapshotRequest = verdict.request;
    expect(branded).toBe(REQUEST);
    // …and it validated THIS statement, not some other one. Without this the mint
    // could ignore its argument entirely and still satisfy the line above.
    expect(validateSqlCalls).toEqual([
      { sql: REQUEST.sql, connectionId: "warehouse-replica", workspaceId: REQUEST.workspaceId },
    ]);
  });

  test("the refusing arm carries the gate's own reason and no request", async () => {
    validateSqlCalls = [];
    nextResult = { valid: false, error: 'Table "accounts" is not in this workspace\'s whitelist' };

    const verdict = await producer.defaultValidateSnapshotSql(REQUEST);

    expect(verdict.valid).toBe(false);
    if (verdict.valid) throw new Error("the stubbed gate said no; the mint passed it");
    // The gate's text, verbatim. Collapsing it to a generic string is what put a
    // `?? "no reason given"` into the run loop once already.
    expect(verdict.error).toBe('Table "accounts" is not in this workspace\'s whitelist');
    // The refusing arm is deliberately unbranded — there is nothing to forge on it,
    // and a `request` here would be a token for a statement that did NOT pass.
    expect("request" in verdict).toBe(false);
  });
});
