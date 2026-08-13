/**
 * Residue-sweep unit falsifiers (#5185).
 *
 * The AC this exists to satisfy, quoted: *"A sentinel denylist is mandatory and
 * tested — a fixture seeding `_default` / `<atlas-operator>` / `` asserts they
 * are never selected. This is the whole risk of the command."*
 *
 * ⚠️ **Asserting only "it was not deleted" would pass with the denylist
 * DELETED.** All three named sentinels are ALSO caught by a structural arm of
 * `classifyScopeValue` — `_default` by the leading-underscore rule,
 * `<atlas-operator>` by the id-shape rule, `""` by the whitespace rule. A test
 * that checks the outcome and not the reason is a fixture that agrees with the
 * implementation by construction: it cannot tell the denylist from its backstop,
 * so removing the denylist entirely would leave it green.
 *
 * So the denylist arm is pinned on its REASON, which no structural arm produces,
 * and the structural arms are pinned separately on values that are NOT on the
 * denylist (`_global`, `{{tpl}}`, `"  "`, `default`) so each proves something
 * the other cannot. Measured on the current suite: emptying `SCOPE_SENTINELS`
 * fails FOUR tests — the three reason assertions plus the `toHaveLength(3)`
 * that stops the per-entry loop passing vacuously — and nothing else. (An
 * earlier revision of this sentence said three; the length assertion was added
 * after it was written, which is how a measurement rots.)
 *
 * The other properties under test — most were round-1 findings; the last two
 * arrived later, and are noted where they did:
 *
 *  - the candidate table set is DERIVED from `purge-scope.ts`, so an
 *    `anonymized` table (`admin_action_log`, whose rows are meant to survive)
 *    can never reach the sweep;
 *  - a table the sweep could not READ is `unreadable`, not a benign skip — the
 *    distinction the exit code keys on, because "we could not look" must not
 *    script as "it was clean" — and a per-row anomaly discards the WHOLE table,
 *    not one row;
 *  - the retry loop is BOUNDED, so the mutation that removes its fixed-point
 *    break terminates and reddens instead of hanging (a hang is not a
 *    falsifier — `bun test`'s timer never fires inside a tight microtask loop);
 *  - the orphan query carries `IS NOT NULL`, without which every NULL-scope row
 *    (`prompt_collections`' built-in library rows, `email_outbox`'s
 *    password-reset rows) reads as residue;
 *  - `DeletableValue` is unforgeable, so a value that skipped the classifier
 *    cannot reach the delete — that arm is a COMPILE error, checked by tsc
 *    rather than here;
 *  - the DELETE re-asserts the orphan predicate rather than trusting the
 *    enumeration's read, AND carries its own `EXISTS (… organization)`
 *    precondition — the second half was not a round-1 finding, it is the one
 *    the first version of that fix left out;
 *  - a relation that is not an ordinary or partitioned table is `unreadable`,
 *    never `relation-absent`. ⚠️ The arms here exercise the JS branch only —
 *    the SQL's own `WHERE` can only be falsified by a real relation, which is
 *    `residue-sweep-pg.test.ts`'s VIEW test.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_RESIDUE_WORKSPACES,
  RESERVED_SCOPE_WORDS,
  SCOPE_SENTINELS,
  SWEEPABLE_SCOPE_TYPES,
  assertOrganizationPopulated,
  checkResidueBlastRadius,
  classifyScopeValue,
  discoverResidueTargets,
  enumerateOrphanValues,
  executeResidueDeletes,
  isBenignSkip,
  planResidueSweep,
  quoteIdent,
  sweepResidue,
  type DeletableValue,
  type OrphanValue,
  type ResidueQuery,
} from "../residue-sweep";
import { PURGE_TABLE_DECISIONS, PURGED_TABLES } from "../purge-scope";

/**
 * Build a `ResidueQuery` fake from a concretely-typed implementation.
 *
 * `ResidueQuery` is generic in its return row, so an ordinary async function is
 * not assignable to it and every fake needs a cast. Funnelling them through one
 * helper means the fake BODIES are still checked against a real return type —
 * ten scattered `as ResidueQuery` casts would erase that, which is the
 * type-level form of a fixture agreeing with the implementation by
 * construction.
 */
type FakeImpl = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
const fakeQuery = (impl: FakeImpl): ResidueQuery => impl as ResidueQuery;

/** Every fake DB answers the organization-population precondition. */
const ORG_COUNT_ROWS = [{ n: "3" }];
const isOrgCount = (sql: string) => sql.includes("count(*)::text AS n FROM public.organization");

describe("classifyScopeValue — the sentinel guard", () => {
  test("`_default` is withheld with the DENYLIST's reason, not the structural one", () => {
    const verdict = classifyScopeValue("_default");
    expect(verdict.kind).toBe("withheld");
    // Naming the SLA default tier is only producible by the denylist entry. The
    // leading-underscore backstop would say "by convention" instead.
    expect(verdict.kind === "withheld" && verdict.reason).toContain("default tier row");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("sla_thresholds");
  });

  test("`<atlas-operator>` is withheld with the DENYLIST's reason, not the shape rule", () => {
    const verdict = classifyScopeValue("<atlas-operator>");
    expect(verdict.kind).toBe("withheld");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("crm_outbox");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("0106");
  });

  test("the empty string is withheld with the DENYLIST's reason, not the whitespace rule", () => {
    const verdict = classifyScopeValue("");
    expect(verdict.kind).toBe("withheld");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("admin_action_log");
  });

  test("every denylist entry is withheld and reports its own recorded reason", () => {
    // The length assertion is what stops this passing VACUOUSLY on an emptied
    // denylist — the loop body would simply never run.
    expect(SCOPE_SENTINELS).toHaveLength(3);
    for (const sentinel of SCOPE_SENTINELS) {
      const verdict = classifyScopeValue(sentinel.value);
      expect(verdict).toEqual({ kind: "withheld", reason: sentinel.reason });
    }
  });

  // The structural arms, proven on values NO denylist entry covers — so these
  // stay green if the denylist is deleted and red if the arm is.
  test("an unlisted `_`-prefixed value is withheld by the convention rule", () => {
    const verdict = classifyScopeValue("_global");
    expect(verdict.kind).toBe("withheld");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("by convention");
  });

  test("an unlisted odd-shaped value is withheld by the id-shape rule", () => {
    const verdict = classifyScopeValue("{{workspace}}");
    expect(verdict.kind).toBe("withheld");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("shape of a workspace id");
  });

  test("a whitespace-only value is withheld by the whitespace rule", () => {
    const verdict = classifyScopeValue("   ");
    expect(verdict.kind).toBe("withheld");
    expect(verdict.kind === "withheld" && verdict.reason).toContain("whitespace-only");
  });

  test("a reserved marker word is withheld even though it is a valid identifier", () => {
    // `default` passes the shape rule and does not start with `_` — it is only
    // withheld by the reserved-word arm. This is the `_default` class one
    // spelling over, and the arm exists because the denylist can only ever name
    // sentinels someone was already bitten by.
    for (const word of ["default", "global", "PLATFORM"]) {
      const verdict = classifyScopeValue(word);
      expect(verdict.kind).toBe("withheld");
      expect(verdict.kind === "withheld" && verdict.reason).toContain("reserved deployment-wide");
    }
    expect(RESERVED_SCOPE_WORDS.length).toBeGreaterThan(5);
  });

  test("a real workspace id is residue", () => {
    // The genuine prod residue from the 2026-08-12 sweep.
    expect(classifyScopeValue("jukFiKym65bnNAYGiY1zdthspoNUYpov")).toEqual({ kind: "residue" });
    // The other live id shape — `org_`-prefixed, as the API docs example uses.
    expect(classifyScopeValue("org_abc123")).toEqual({ kind: "residue" });
  });
});

describe("assertOrganizationPopulated — the broken-premise guard", () => {
  test("refuses a database with zero organizations", async () => {
    const query = fakeQuery(async () => [{ n: "0" }]);
    await expect(assertOrganizationPopulated(query)).rejects.toThrow(
      /organization has 0 rows/,
    );
  });

  test("refuses when the count cannot be read at all", async () => {
    const query = fakeQuery(async () => []);
    await expect(assertOrganizationPopulated(query)).rejects.toThrow(
      /could not count public.organization/,
    );
  });

  test("returns the count when the premise holds", async () => {
    const query = fakeQuery(async () => [{ n: "42" }]);
    expect(await assertOrganizationPopulated(query)).toBe(42);
  });

  test("sweepResidue refuses BEFORE issuing any other statement", async () => {
    const statements: string[] = [];
    const query = fakeQuery(async (sql) => {
      statements.push(sql);
      return isOrgCount(sql) ? [{ n: "0" }] : [];
    });

    await expect(sweepResidue(query, { dryRun: true })).rejects.toThrow(/0 rows/);
    // Nothing was enumerated on a premise the sweep knows is broken.
    expect(statements).toHaveLength(1);
  });
});

describe("checkResidueBlastRadius", () => {
  // Routed through the plan, because the guard now takes `DeletableValue[]` —
  // it decides whether the destructive call may happen, so handing it a raw
  // `OrphanValue[]` (or `plan.withheld`, which would compute the cap over
  // sentinels and mask the real plan's size) is the one-identifier slip the
  // brand exists for. This no longer compiles as a plain array.
  const many = (n: number): readonly DeletableValue[] =>
    planResidueSweep(
      Array.from({ length: n }, (_, i) => ({
        table: "crm_outbox",
        column: "workspace_id",
        value: `ws${i}`,
        rows: 1,
      })),
    ).deletable;

  test("fires past the cap, naming the count", () => {
    const warning = checkResidueBlastRadius(many(MAX_RESIDUE_WORKSPACES + 1));
    expect(warning).toContain(String(MAX_RESIDUE_WORKSPACES + 1));
    expect(warning).toContain("wrong DB");
    expect(warning).toContain("not a finding");
  });

  test("is silent at exactly the cap", () => {
    expect(checkResidueBlastRadius(many(MAX_RESIDUE_WORKSPACES))).toBeNull();
  });

  test("counts distinct WORKSPACE IDS, not rows", () => {
    // 200 rows across 2 ids is a small blast radius; counting rows would fire.
    const twoIds: OrphanValue[] = [
      { table: "audit_log", column: "org_id", value: "wsAAA", rows: 100 },
      { table: "audit_log", column: "org_id", value: "wsBBB", rows: 100 },
    ];
    expect(checkResidueBlastRadius(planResidueSweep(twoIds).deletable)).toBeNull();
  });
});

describe("planResidueSweep", () => {
  test("splits the 2026-08-12 prod result set into 1 deletable and 3 withheld", () => {
    // Deliberately unequal row counts per class: with 1/1/1/1 an implementation
    // that mixed the two lists up would still satisfy a totals assertion.
    const orphans: OrphanValue[] = [
      { table: "sla_thresholds", column: "workspace_id", value: "_default", rows: 3 },
      { table: "crm_outbox", column: "workspace_id", value: "<atlas-operator>", rows: 7 },
      { table: "settings", column: "org_id", value: "", rows: 2 },
      {
        table: "workspace_proactive_config",
        column: "workspace_id",
        value: "jukFiKym65bnNAYGiY1zdthspoNUYpov",
        rows: 1,
      },
    ];

    const plan = planResidueSweep(orphans);

    expect(plan.deletable.map((d) => d.value)).toEqual(["jukFiKym65bnNAYGiY1zdthspoNUYpov"]);
    expect(plan.withheld.map((w) => w.value).sort()).toEqual([
      "",
      "<atlas-operator>",
      "_default",
    ]);
    expect(plan.withheld.reduce((n, w) => n + w.rows, 0)).toBe(12);
    expect(plan.deletable.reduce((n, d) => n + d.rows, 0)).toBe(1);
    // Every withheld value carries a reason — "no silent filtering".
    for (const w of plan.withheld) expect(w.reason.length).toBeGreaterThan(0);
  });
});

describe("discoverResidueTargets — the candidate set is registry-derived", () => {
  interface FakeSchema {
    columns: { table_name: string; column_name: string; data_type: string }[];
    /** Tables the catalog finds. Defaults to every candidate. */
    present?: string[];
    /** Per-table `pg_class.relkind`. Defaults to `"r"` (an ordinary table). */
    relkind?: Record<string, string>;
  }

  /**
   * Stand in for the single `pg_catalog` LEFT JOIN. A present table with no
   * scope column yields one row with NULL `column_name`, which is how presence
   * and scope come back from one privilege-blind query.
   */
  function schemaQuery(schema: FakeSchema): ResidueQuery {
    return fakeQuery(async (sql, params) => {
      if (isOrgCount(sql)) return ORG_COUNT_ROWS;
      if (sql.includes("pg_attribute")) {
        const asked = (params?.[0] ?? []) as string[];
        const scopeColumns = (params?.[1] ?? []) as string[];
        const present = schema.present ?? asked;
        return asked.flatMap((table): Array<Record<string, unknown>> => {
          if (!present.includes(table)) return [];
          // The real query filters on attname too; a laxer fake could "prove" a
          // target on a column the sweep would never see.
          const relkind = schema.relkind?.[table] ?? "r";
          const cols = schema.columns.filter(
            (c) => c.table_name === table && scopeColumns.includes(c.column_name),
          );
          return cols.length > 0
            ? cols.map((c) => ({ ...c, relkind }))
            : [{ table_name: table, relkind, column_name: null, data_type: null }];
        });
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  }

  test("`anonymized` and `retained` tables are never candidates", async () => {
    const query = schemaQuery({
      columns: [
        { table_name: "admin_action_log", column_name: "org_id", data_type: "text" },
        { table_name: "user_trial_grants", column_name: "org_id", data_type: "text" },
        { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" },
      ],
    });

    const { targets, skipped } = await discoverResidueTargets(query);
    const touched = new Set([...targets.map((t) => t.table), ...skipped.map((s) => s.table)]);

    // admin_action_log is `anonymized` — its rows SURVIVE a purge by design, and
    // the empty-string orphan the prod sweep flagged lives in it.
    expect(PURGE_TABLE_DECISIONS.admin_action_log.decision).toBe("anonymized");
    expect(touched.has("admin_action_log")).toBe(false);
    expect(PURGE_TABLE_DECISIONS.user_trial_grants.decision).toBe("retained");
    expect(touched.has("user_trial_grants")).toBe(false);
    expect(targets).toContainEqual({ table: "sla_thresholds", column: "workspace_id" });
  });

  test("every `purged` table is either a target or a reported skip — nothing vanishes", async () => {
    const query = schemaQuery({
      columns: [{ table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" }],
    });

    const { targets, skipped } = await discoverResidueTargets(query);
    const accounted = new Set([...targets.map((t) => t.table), ...skipped.map((s) => s.table)]);

    // Length assertions first: both loops below pass vacuously on an empty
    // iterable, which is the same shape the SCOPE_SENTINELS loop needed closing.
    expect(PURGED_TABLES.size).toBeGreaterThan(50);
    expect(skipped.length).toBeGreaterThan(0);
    for (const table of PURGED_TABLES) expect(accounted.has(table)).toBe(true);
    for (const skip of skipped) expect(skip.reason.length).toBeGreaterThan(0);
  });

  test("an absent relation and a scope-less table get DIFFERENT kinds, both benign", async () => {
    // `messages` is `purged` but has no scope column — the purge reaches it
    // through a conversation_id subquery, which is a different operator response
    // from "the region is behind on migrations".
    const query = schemaQuery({
      columns: [{ table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" }],
      present: ["sla_thresholds", "messages"],
    });

    const { skipped } = await discoverResidueTargets(query);
    const messages = skipped.find((s) => s.table === "messages");
    const absent = skipped.find((s) => s.table === "conversations");

    expect(messages?.kind).toBe("no-scope-column");
    // The registry's own reason is quoted, so the parent path is in the output.
    expect(messages?.reason).toContain("conversation");
    expect(absent?.kind).toBe("relation-absent");
    expect(messages && isBenignSkip(messages)).toBe(true);
    expect(absent && isBenignSkip(absent)).toBe(true);
  });

  test("discovery reads pg_catalog, which no privilege grant can filter", async () => {
    // ⚠️ Both `information_schema.tables` AND `.columns` are privilege-filtered,
    // the latter per COLUMN. A role holding column-level grants that exclude the
    // scope column saw an empty column list and the sweep reported "no workspace
    // scope column — the purge reaches this table through a parent subquery":
    // confident, specific, false, and filed as BENIGN so the run exited 0.
    // `pg_class`/`pg_attribute` answer regardless of grant, so "no scope column"
    // is now a structural fact; a table the role cannot READ fails in
    // enumerateOrphanValues instead and is recorded as `unreadable` — measured,
    // not inferred from an absence.
    let captured = "";
    const query = fakeQuery(async (sql, params) => {
      if (isOrgCount(sql)) return ORG_COUNT_ROWS;
      captured = sql;
      const asked = (params?.[0] ?? []) as string[];
      return asked.map((t) => ({ table_name: t, column_name: null, data_type: null }));
    });

    await discoverResidueTargets(query);

    expect(captured).toContain("pg_attribute");
    expect(captured).toContain("pg_class");
    expect(captured).not.toContain("information_schema");
  });

  test("a scope column of an uncomparable type is skipped, with the type named", async () => {
    const query = schemaQuery({
      columns: [{ table_name: "sla_thresholds", column_name: "workspace_id", data_type: "integer" }],
    });

    const { targets, skipped } = await discoverResidueTargets(query);

    expect(targets.some((t) => t.table === "sla_thresholds")).toBe(false);
    const skip = skipped.find((s) => s.table === "sla_thresholds" && s.column === "workspace_id");
    expect(skip?.kind).toBe("unsweepable-type");
    expect(skip?.reason).toContain('data type "integer"');
  });

  test("`uuid` is NOT sweepable — for a DELETE, 'never matches' means 'delete everything'", async () => {
    expect(SWEEPABLE_SCOPE_TYPES).not.toContain("uuid");
    const query = schemaQuery({
      columns: [{ table_name: "sla_thresholds", column_name: "workspace_id", data_type: "uuid" }],
    });

    const { targets, skipped } = await discoverResidueTargets(query);

    expect(targets.some((t) => t.table === "sla_thresholds")).toBe(false);
    expect(skipped.find((s) => s.table === "sla_thresholds")?.kind).toBe("unsweepable-type");
  });

  test("a table with one sweepable and one uncomparable column yields a target AND a skip", async () => {
    const query = schemaQuery({
      columns: [
        { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" },
        { table_name: "sla_thresholds", column_name: "reference_id", data_type: "integer" },
      ],
    });

    const { targets, skipped } = await discoverResidueTargets(query);

    expect(targets).toContainEqual({ table: "sla_thresholds", column: "workspace_id" });
    const skip = skipped.find((s) => s.table === "sla_thresholds");
    expect(skip?.kind).toBe("unsweepable-type");
    expect(skip?.column).toBe("reference_id");
  });

  test("a relation that is not an ordinary or partitioned table is UNREADABLE, not absent", async () => {
    // `relkind` used to be filtered in the WHERE clause, so a view, a matview or
    // a PARTITIONED table returned zero rows and read as "relation absent — run
    // the region's migrations": benign, exit 0, and a remedy that can never
    // work. That is verbatim the false-benign diagnosis the catalog query was
    // written to remove, one arm over.
    const asView = fakeQuery(async (sql, params) => {
      if (isOrgCount(sql)) return ORG_COUNT_ROWS;
      if (sql.includes("pg_attribute")) {
        const asked = (params?.[0] ?? []) as string[];
        return asked.map((t) => ({
          table_name: t,
          relkind: t === "sla_thresholds" ? "v" : "r",
          column_name: t === "sla_thresholds" ? null : "workspace_id",
          data_type: t === "sla_thresholds" ? null : "text",
        }));
      }
      return [];
    });

    const { targets, skipped } = await discoverResidueTargets(asView);
    const sla = skipped.find((s) => s.table === "sla_thresholds");

    expect(targets.some((t) => t.table === "sla_thresholds")).toBe(false);
    expect(sla?.kind).toBe("unreadable");
    expect(sla?.reason).toContain('relkind "v"');
    expect(sla && isBenignSkip(sla)).toBe(false);
  });

  test("a PARTITIONED table is swept, not skipped", async () => {
    // The other half of the same delta: `relkind = 'p'` is deletable. Filtering
    // to `'r'` would have lost `messages`/`agent_runs`/`audit_log` the day any
    // of them is partitioned — silently, as `relation-absent`.
    const partitioned = fakeQuery(async (sql, params) => {
      if (isOrgCount(sql)) return ORG_COUNT_ROWS;
      if (sql.includes("pg_attribute")) {
        const asked = (params?.[0] ?? []) as string[];
        return asked.map((t) => ({
          table_name: t,
          relkind: t === "audit_log" ? "p" : "r",
          column_name: "org_id",
          data_type: "text",
        }));
      }
      return [];
    });

    const { targets } = await discoverResidueTargets(partitioned);
    expect(targets).toContainEqual({ table: "audit_log", column: "org_id" });
  });

  test("TWO sweepable scope columns on one table is refused, not guessed at", async () => {
    // A row orphaned on column A but pointing at a LIVE workspace through column
    // B would be destroyed on A's verdict alone. No purged table has two today;
    // schema drift in one region is enough to create the case.
    const query = schemaQuery({
      columns: [
        { table_name: "sla_thresholds", column_name: "org_id", data_type: "text" },
        { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" },
      ],
    });

    const { targets, skipped } = await discoverResidueTargets(query);

    expect(targets.some((t) => t.table === "sla_thresholds")).toBe(false);
    const skip = skipped.find((s) => s.table === "sla_thresholds");
    expect(skip?.kind).toBe("unreadable");
    expect(skip?.reason).toContain("2 workspace scope columns");
  });
});

describe("enumerateOrphanValues", () => {
  test("a failing table is `unreadable`, not a benign skip, and the sweep continues", async () => {
    const query = fakeQuery(async (sql) => {
      if (sql.includes("sla_thresholds")) throw new Error("permission denied for table");
      return [{ scope_value: "wsAAA", row_count: "4" }];
    });

    const { orphans, skipped } = await enumerateOrphanValues(query, [
      { table: "sla_thresholds", column: "workspace_id" },
      { table: "crm_outbox", column: "workspace_id" },
    ]);

    expect(orphans).toEqual([
      { table: "crm_outbox", column: "workspace_id", value: "wsAAA", rows: 4 },
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.kind).toBe("unreadable");
    expect(skipped[0]?.reason).toContain("permission denied");
  });

  test("the query carries IS NOT NULL — without it every NULL-scope row is an 'orphan'", async () => {
    // `NOT EXISTS (o.id = NULL)` is TRUE. `prompt_collections` ships built-in
    // library rows with org_id NULL and `email_outbox` holds session-less
    // password-reset rows; both would be swept.
    let captured = "";
    const query = fakeQuery(async (sql) => {
      captured = sql;
      return [];
    });

    await enumerateOrphanValues(query, [{ table: "prompt_collections", column: "org_id" }]);

    expect(captured).toContain('t."org_id" IS NOT NULL');
  });

  test("both sides of the organization comparison are cast to text", async () => {
    let captured = "";
    const query = fakeQuery(async (sql) => {
      captured = sql;
      return [];
    });

    await enumerateOrphanValues(query, [{ table: "region_migrations", column: "org_id" }]);

    expect(captured).toContain('o.id = t."org_id"::text');
  });

  test("a NULL scope value discards the WHOLE table, not just that row", async () => {
    // ⚠️ Two properties, and the second was a round-2 finding. First:
    // planResidueSweep runs OUTSIDE the per-target try, so a TypeError from
    // `value.trim()` would abort the whole sweep with no useful message.
    // Second: continuing the ROW loop declared the table's state UNKNOWN and
    // then proposed its other rows for deletion anyway — on the strength of the
    // very query that had just been called untrustworthy.
    const query = fakeQuery(async () => [
      { scope_value: null, row_count: "3" },
      { scope_value: "wsAAA", row_count: "1" },
    ]);

    const { orphans, skipped } = await enumerateOrphanValues(query, [
      { table: "prompt_collections", column: "org_id" },
    ]);

    expect(orphans).toEqual([]);
    expect(skipped[0]?.kind).toBe("unreadable");
    expect(skipped[0]?.reason).toContain("NULL scope value");
    expect(skipped[0]?.reason).toContain("No value from this table is proposed for deletion");
  });

  test("an unparseable row count discards the whole table too", async () => {
    const query = fakeQuery(async () => [
      { scope_value: "wsAAA", row_count: "not-a-number" },
      { scope_value: "wsBBB", row_count: "2" },
    ]);

    const { orphans, skipped } = await enumerateOrphanValues(query, [
      { table: "crm_outbox", column: "workspace_id" },
    ]);

    expect(orphans).toEqual([]);
    expect(skipped[0]?.kind).toBe("unreadable");
    expect(skipped[0]?.reason).toContain("unparseable row count");
  });

  test("a clean table's values all reach the orphan list", async () => {
    // The control: the discard arms above must not be firing on ordinary input.
    const query = fakeQuery(async () => [
      { scope_value: "wsAAA", row_count: "4" },
      { scope_value: "wsBBB", row_count: "2" },
    ]);

    const { orphans, skipped } = await enumerateOrphanValues(query, [
      { table: "crm_outbox", column: "workspace_id" },
    ]);

    expect(orphans.map((o) => o.rows)).toEqual([4, 2]);
    expect(skipped).toEqual([]);
  });
});

describe("executeResidueDeletes", () => {
  /** Values are only deletable once classified; route fixtures through the plan. */
  const plan = (orphans: OrphanValue[]): readonly DeletableValue[] =>
    planResidueSweep(orphans).deletable;

  /**
   * Wrap a fake so it answers the two preconditions `executeResidueDeletes` now
   * re-establishes for itself. They are re-established HERE, not only in
   * `sweepResidue`, because this function is exported and callable standalone —
   * and because the SQL's own `EXISTS` clause, when it fires, is indistinguishable
   * from "there was nothing to delete".
   */
  const withPremise =
    (impl: FakeImpl): ResidueQuery =>
    fakeQuery(async (sql, params) => (isOrgCount(sql) ? ORG_COUNT_ROWS : impl(sql, params)));

  test("the DELETE names the exact values the plan listed, and no others", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const query = withPremise(async (sql, params) => {
      seen.push({ sql, params: params ?? [] });
      return [{ deleted: 1 }, { deleted: 1 }, { deleted: 1 }, { deleted: 1 }, { deleted: 1 }, { deleted: 1 }, { deleted: 1 }, { deleted: 1 }];
    });

    const { deletions, errors } = await executeResidueDeletes(
      query,
      plan([
        { table: "workspace_proactive_config", column: "workspace_id", value: "wsAAA", rows: 3 },
        { table: "workspace_proactive_config", column: "workspace_id", value: "wsBBB", rows: 5 },
      ]),
    );

    expect(errors).toEqual([]);
    expect(seen).toHaveLength(1); // one statement per (table, column)
    expect(seen[0]?.params[0]).toEqual(["wsAAA", "wsBBB"]);
    // 3 + 5, not 2 (the value count) and not 1+1 — with equal counts a `+1`
    // accumulator, a sum, and a length are all indistinguishable.
    expect(deletions[0]).toMatchObject({ expectedRows: 8, deletedRows: 8 });
    expect(deletions[0]?.values).toHaveLength(2);
  });

  test("the DELETE carries BOTH the orphan predicate and its own precondition", async () => {
    // Additive by construction: both clauses can only ever delete FEWER rows, so
    // a workspace re-created between preview and execute is spared.
    //
    // ⚠️ The `EXISTS (SELECT 1 FROM public.organization)` clause is the one the
    // first version of this fix left out, and its absence made the `NOT EXISTS`
    // vacuous in exactly the state it was written for: with an empty
    // organization table, `NOT EXISTS (o.id = …)` is true for every row.
    // `assertOrganizationPopulated` covers `sweepResidue`, but this function is
    // exported and callable directly — as the tests above do.
    let captured = "";
    const query = withPremise(async (sql) => {
      captured = sql;
      return [];
    });

    await executeResidueDeletes(
      query,
      plan([{ table: "crm_outbox", column: "workspace_id", value: "wsAAA", rows: 1 }]),
    );

    expect(captured).toContain("AND EXISTS (SELECT 1 FROM public.organization)");
    expect(captured).toContain("NOT EXISTS");
    expect(captured).toContain("FROM public.organization o");
  });

  test("a RESTRICT failure is retried once its sibling clears, then succeeds", async () => {
    // brain_episodes cannot go while brain_facts still references it. The retry
    // exists so the sweep does not carry a second copy of the purge's ordering.
    let factsDeleted = false;
    const query = withPremise(async (sql) => {
      if (sql.includes("brain_facts")) {
        factsDeleted = true;
        return [{ deleted: 1 }, { deleted: 1 }, { deleted: 1 }];
      }
      if (!factsDeleted) {
        throw new Error('update or delete on table "brain_episodes" violates foreign key constraint');
      }
      return [{ deleted: 1 }];
    });

    const { deletions, errors } = await executeResidueDeletes(
      query,
      plan([
        { table: "brain_episodes", column: "workspace_id", value: "wsAAA", rows: 1 },
        { table: "brain_facts", column: "workspace_id", value: "wsAAA", rows: 3 },
      ]),
    );

    expect(errors).toEqual([]);
    // Unequal counts on purpose: with 1 and 1 this could not tell the two apart.
    expect(deletions.find((d) => d.table === "brain_facts")?.deletedRows).toBe(3);
    expect(deletions.find((d) => d.table === "brain_episodes")?.deletedRows).toBe(1);
  });

  test("a permanently failing delete TERMINATES in a bounded number of statements", async () => {
    // ⚠️ This is the shape the pass bound exists for. With only the `progressed`
    // break, removing that break makes this a tight unbounded microtask loop
    // that STARVES bun's timer queue — the suite hangs instead of failing, and a
    // hang is not a falsifier. Counting statements is what reddens.
    let statements = 0;
    const query = withPremise(async () => {
      statements += 1;
      throw new Error("violates foreign key constraint");
    });

    const { deletions, errors } = await executeResidueDeletes(
      query,
      plan([
        { table: "brain_episodes", column: "workspace_id", value: "wsAAA", rows: 1 },
        { table: "brain_facts", column: "workspace_id", value: "wsAAA", rows: 3 },
      ]),
    );

    expect(deletions).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toContain("foreign key");
    // One pass over two groups. Never more — the loop cannot spin.
    expect(statements).toBe(2);
  });

  test("a failed delete reports how many rows SURVIVE", async () => {
    const query = withPremise(async () => {
      throw new Error("deadlock detected");
    });

    const { errors } = await executeResidueDeletes(
      query,
      plan([{ table: "audit_log", column: "org_id", value: "wsAAA", rows: 41 }]),
    );

    expect(errors[0]).toMatchObject({ expectedRows: 41, table: "audit_log" });
  });

  test("a delete that removes fewer rows than enumerated keeps BOTH numbers", async () => {
    const query = withPremise(async () => [{ deleted: 1 }]);

    const { deletions } = await executeResidueDeletes(
      query,
      plan([{ table: "crm_outbox", column: "workspace_id", value: "wsAAA", rows: 5 }]),
    );

    expect(deletions[0]).toMatchObject({ expectedRows: 5, deletedRows: 1 });
  });
});

describe("sweepResidue", () => {
  /**
   * A fake region DB holding one sentinel and one genuine residue value.
   * `deleteFails` drives the error path.
   */
  function region(
    options: { deleteFails?: boolean; orphanIds?: string[] } = {},
  ): ResidueQuery {
    return fakeQuery(async (sql) => {
      if (isOrgCount(sql)) return ORG_COUNT_ROWS;
      if (sql.startsWith("DELETE")) {
        if (options.deleteFails) throw new Error("violates foreign key constraint");
        return [{ deleted: 1 }];
      }
      if (sql.includes("pg_attribute")) {
        return [
          {
            table_name: "sla_thresholds",
            relkind: "r",
            column_name: "workspace_id",
            data_type: "text",
          },
          {
            table_name: "workspace_proactive_config",
            relkind: "r",
            column_name: "workspace_id",
            data_type: "text",
          },
        ];
      }
      if (sql.includes("sla_thresholds")) return [{ scope_value: "_default", row_count: "2" }];
      const ids = options.orphanIds ?? ["jukFiKym65bnNAYGiY1zdthspoNUYpov"];
      return ids.map((value) => ({ scope_value: value, row_count: "1" }));
    });
  }

  test("a DRY RUN issues no DELETE", async () => {
    const statements: string[] = [];
    const base = region();
    const spy = fakeQuery(async (sql, params) => {
      statements.push(sql);
      return base(sql, params);
    });

    const report = await sweepResidue(spy, { dryRun: true });

    expect(statements.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(report.wouldDelete.map((d) => d.value)).toEqual(["jukFiKym65bnNAYGiY1zdthspoNUYpov"]);
    expect(report.withheld.map((w) => w.value)).toEqual(["_default"]);
    expect(report.totals.rowsDeleted).toBe(0);
    // Unequal on purpose — 2 withheld rows vs 1 deletable.
    expect(report.totals.rowsWithheld).toBe(2);
    expect(report.totals.rowsWouldDelete).toBe(1);
    expect(report.tablesConsidered).toBe(PURGED_TABLES.size);
  });

  test("EXECUTE deletes the residue and NOT the sentinel's table", async () => {
    const statements: string[] = [];
    const base = region();
    const spy = fakeQuery(async (sql, params) => {
      statements.push(sql);
      return base(sql, params);
    });

    const report = await sweepResidue(spy, { dryRun: false });

    const deletes = statements.filter((s) => s.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("workspace_proactive_config");
    expect(deletes.some((s) => s.includes("sla_thresholds"))).toBe(false);
    expect(report.totals.rowsDeleted).toBe(1);
    expect(report.withheld.map((w) => w.value)).toEqual(["_default"]);
    expect(report.refusedToExecute).toBeNull();
  });

  test("`tablesNotInScope` and `tablesUnreadable` are counted separately", async () => {
    const report = await sweepResidue(region(), { dryRun: true });

    // Every purged table but the two present ones is `relation-absent`.
    expect(report.totals.tablesNotInScope).toBe(PURGED_TABLES.size - 2);
    expect(report.totals.tablesUnreadable).toBe(0);
  });

  test("an unreadable table shows up in `tablesUnreadable`, never as 'not in scope'", async () => {
    const base = region();
    const query = fakeQuery(async (sql, params) => {
      if (sql.includes("FROM public.\"sla_thresholds\"")) throw new Error("permission denied");
      return base(sql, params);
    });

    const report = await sweepResidue(query, { dryRun: true });

    expect(report.totals.tablesUnreadable).toBe(1);
    expect(report.skipped.filter((s) => !isBenignSkip(s))[0]?.table).toBe("sla_thresholds");
    // ...and the withheld sentinel is gone, because that table was never read —
    // which is exactly why "0 residue" must not read as "clean".
    expect(report.withheld).toEqual([]);
  });

  test("an implausible plan FLAGS a dry run — it is not silently previewed", async () => {
    // ⚠️ The first version of the blast-radius guard read `if (dryRun) return
    // null`, sitting beside `assertOrganizationPopulated`, whose whole argument
    // is that a preview built on a broken premise is worse than no preview.
    // Two guards for the same premise, one commit, disagreeing about previews.
    const tooMany = Array.from({ length: MAX_RESIDUE_WORKSPACES + 1 }, (_, i) => `wsOrphan${i}`);
    const report = await sweepResidue(region({ orphanIds: tooMany }), { dryRun: true });

    expect(report.blastRadiusWarning).toContain("wrong DB");
    // The preview still lists everything — nothing is hidden from the operator.
    expect(report.wouldDelete).toHaveLength(tooMany.length);
    // ...but it is not a clean EXECUTE refusal either; that arm is mode-specific.
    expect(report.refusedToExecute).toBeNull();
  });

  test("an implausible plan REFUSES an execute, and deletes nothing", async () => {
    const tooMany = Array.from({ length: MAX_RESIDUE_WORKSPACES + 1 }, (_, i) => `wsOrphan${i}`);
    const statements: string[] = [];
    const base = region({ orphanIds: tooMany });
    const spy = fakeQuery(async (sql, params) => {
      statements.push(sql);
      return base(sql, params);
    });

    const report = await sweepResidue(spy, { dryRun: false });

    expect(report.refusedToExecute).toContain("wrong DB");
    expect(report.blastRadiusWarning).toBe(report.refusedToExecute);
    expect(statements.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(report.totals.rowsDeleted).toBe(0);
  });

  test("a plan at exactly the cap carries no warning in EITHER mode", async () => {
    // Named as a boundary-plus-matrix claim, so it has to actually be one: the
    // previous version ran one orphan id in one mode and re-tested its own
    // fixture. `MAX_RESIDUE_WORKSPACES` ids, both modes.
    const atCap = Array.from({ length: MAX_RESIDUE_WORKSPACES }, (_, i) => `wsOrphan${i}`);
    for (const dryRun of [true, false]) {
      const report = await sweepResidue(region({ orphanIds: atCap }), { dryRun });
      expect(report.blastRadiusWarning).toBeNull();
      expect(report.refusedToExecute).toBeNull();
    }
  });

  test("a sweep that can examine NOTHING refuses — it does not report clean", async () => {
    // The symmetric premise to an empty `organization`: "this is not an Atlas
    // schema". Without the guard this prints 87 benign `relation-absent` skips
    // and "No residue found", and exits 0.
    const noAtlasSchema = fakeQuery(async (sql, params) => {
      if (isOrgCount(sql)) return ORG_COUNT_ROWS;
      if (sql.includes("pg_attribute")) return [];
      void params;
      return [];
    });

    await expect(sweepResidue(noAtlasSchema, { dryRun: true })).rejects.toThrow(
      /would examine nothing and report clean/,
    );
  });

  test("a failed delete lands in `errors` with its surviving row count", async () => {

      const report = await sweepResidue(region({ deleteFails: true }), { dryRun: false });

    expect(report.totals.errors).toBe(1);
    expect(report.errors[0]).toMatchObject({
      table: "workspace_proactive_config",
      expectedRows: 1,
    });
  });
});

describe("quoteIdent", () => {
  test("doubles embedded quotes", () => {
    expect(quoteIdent("sla_thresholds")).toBe('"sla_thresholds"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});
