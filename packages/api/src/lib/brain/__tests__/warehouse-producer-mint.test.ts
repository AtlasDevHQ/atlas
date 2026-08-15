/**
 * The production mint's BY-REFERENCE contract (#5230).
 *
 * ## Why this needs its own file
 *
 * `runWarehouseProducer` refuses unless `verdict.request === request` — the
 * anti-replay check. The only production mint is `defaultValidateSnapshotSql`, and
 * nothing asserted that it brands the request it was HANDED rather than a copy of
 * it. That asymmetry is the dangerous kind: an innocuous edit there (`{ ...request }`,
 * a normalized field, a logging Proxy) compiles, keeps every existing suite green,
 * and in production refuses **every entity on every run** as an "Atlas wiring fault".
 * The producer silently stops emitting and the Atlas goes stale.
 *
 * The unit suite cannot cover it. Its real-gate block drives the shipped
 * `defaultValidateSnapshotSql` for real, but the gate's table check is
 * workspace-whitelist-scoped and a test workspace has none — so that block only ever
 * reaches the REFUSING arm, and the refusing arm carries no request. The passing arm
 * is only reachable with the gate itself stubbed, which means `mock.module`, which is
 * process-wide and therefore cannot share a file with suites that want the real one.
 *
 * ⚠️ EVERY value export of `lib/tools/sql` is replaced below. `mock.module` swaps the
 * whole module, so an export left out becomes `undefined` and the first unrelated
 * consumer throws — which reads as a broken test rather than a missing mock.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";

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

const REQUEST: WarehouseSnapshotRequest = {
  workspaceId: "ws-5230-mint",
  entity: "Accounts",
  connectionId: undefined,
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
      { sql: REQUEST.sql, connectionId: undefined, workspaceId: REQUEST.workspaceId },
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
