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
 * denylist (`_global`, `{{tpl}}`, `"  "`) so each proves something the other
 * cannot. Measured: deleting `SCOPE_SENTINELS` fails the three reason
 * assertions and nothing else.
 *
 * The second property under test is that the candidate table set is DERIVED
 * from `purge-scope.ts` rather than hand-written — an `anonymized` table
 * (`admin_action_log`, whose rows are meant to survive) reaching the sweep would
 * be the same class of bug one table over.
 */

import { describe, expect, test } from "bun:test";
import {
  SCOPE_SENTINELS,
  classifyScopeValue,
  discoverResidueTargets,
  enumerateOrphanValues,
  executeResidueDeletes,
  planResidueSweep,
  quoteIdent,
  sweepResidue,
  type OrphanValue,
  type ResidueQuery,
} from "../residue-sweep";
import { PURGE_TABLE_DECISIONS, PURGED_TABLES } from "../purge-scope";

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

  test("a real workspace id is residue", () => {
    // The genuine prod residue from the 2026-08-12 sweep.
    expect(classifyScopeValue("jukFiKym65bnNAYGiY1zdthspoNUYpov")).toEqual({ kind: "residue" });
    // The other live id shape — `org_`-prefixed, as the API docs example uses.
    expect(classifyScopeValue("org_abc123")).toEqual({ kind: "residue" });
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
  /** A fake schema: every candidate present, each with the column it is asked for. */
  function schemaQuery(
    columns: { table_name: string; column_name: string; data_type: string }[],
    presentTables?: string[],
  ): ResidueQuery {
    return (async (sql: string, params?: unknown[]) => {
      if (sql.includes("information_schema.tables")) {
        const asked = (params?.[0] ?? []) as string[];
        const present = presentTables ?? asked;
        return asked.filter((t) => present.includes(t)).map((t) => ({ table_name: t }));
      }
      if (sql.includes("information_schema.columns")) {
        const asked = (params?.[0] ?? []) as string[];
        return columns.filter((c) => asked.includes(c.table_name));
      }
      throw new Error(`unexpected query: ${sql}`);
    }) as ResidueQuery;
  }

  test("`anonymized` and `retained` tables are never candidates", async () => {
    const query = schemaQuery([
      { table_name: "admin_action_log", column_name: "org_id", data_type: "text" },
      { table_name: "user_trial_grants", column_name: "org_id", data_type: "text" },
      { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" },
    ]);

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
    const query = schemaQuery([
      { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" },
    ]);

    const { targets, skipped } = await discoverResidueTargets(query);
    const accounted = new Set([...targets.map((t) => t.table), ...skipped.map((s) => s.table)]);

    for (const table of PURGED_TABLES) expect(accounted.has(table)).toBe(true);
    for (const skip of skipped) expect(skip.reason.length).toBeGreaterThan(0);
  });

  test("an absent relation and a scope-less table get DIFFERENT reasons", async () => {
    // `messages` is `purged` but has no scope column — the purge reaches it
    // through a conversation_id subquery, which is a different operator response
    // from "the region is behind on migrations".
    const query = schemaQuery(
      [{ table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" }],
      ["sla_thresholds", "messages"],
    );

    const { skipped } = await discoverResidueTargets(query);
    const messages = skipped.find((s) => s.table === "messages");
    const absent = skipped.find((s) => s.table === "conversations");

    expect(messages?.reason).toContain("no workspace scope column");
    // The registry's own reason is quoted, so the parent path is in the output.
    expect(messages?.reason).toContain("conversation");
    expect(absent?.reason).toContain("absent from this region's schema");
  });

  test("a scope column of an uncomparable type is skipped, with the type named", async () => {
    const query = schemaQuery([
      { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "integer" },
    ]);

    const { targets, skipped } = await discoverResidueTargets(query);

    expect(targets.some((t) => t.table === "sla_thresholds")).toBe(false);
    const skip = skipped.find((s) => s.table === "sla_thresholds" && s.column === "workspace_id");
    expect(skip?.reason).toContain('data type "integer"');
  });
});

describe("enumerateOrphanValues", () => {
  test("a failing table is reported as a skip and the sweep continues", async () => {
    const query = (async (sql: string) => {
      if (sql.includes("sla_thresholds")) throw new Error("permission denied for table");
      return [{ scope_value: "wsAAA", row_count: "4" }];
    }) as ResidueQuery;

    const { orphans, skipped } = await enumerateOrphanValues(query, [
      { table: "sla_thresholds", column: "workspace_id" },
      { table: "crm_outbox", column: "workspace_id" },
    ]);

    expect(orphans).toEqual([
      { table: "crm_outbox", column: "workspace_id", value: "wsAAA", rows: 4 },
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("permission denied");
  });

  test("both sides of the organization comparison are cast to text", async () => {
    // Without the cast a uuid scope column aborts with `operator does not exist`
    // — the abort class the runbook's data_type filter exists to dodge.
    let captured = "";
    const query = (async (sql: string) => {
      captured = sql;
      return [];
    }) as ResidueQuery;

    await enumerateOrphanValues(query, [{ table: "region_migrations", column: "org_id" }]);

    expect(captured).toContain('o.id = t."org_id"::text');
  });
});

describe("executeResidueDeletes", () => {
  test("the DELETE names the exact values the plan listed, and no others", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const query = (async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return [{ deleted: 1 }, { deleted: 1 }];
    }) as ResidueQuery;

    const { deletions, errors } = await executeResidueDeletes(query, [
      { table: "workspace_proactive_config", column: "workspace_id", value: "wsAAA", rows: 1 },
      { table: "workspace_proactive_config", column: "workspace_id", value: "wsBBB", rows: 1 },
    ]);

    expect(errors).toEqual([]);
    expect(seen).toHaveLength(1); // one statement per (table, column)
    expect(seen[0]?.params[0]).toEqual(["wsAAA", "wsBBB"]);
    expect(deletions[0]).toMatchObject({ expectedRows: 2, deletedRows: 2 });
  });

  test("a RESTRICT failure is retried once its sibling clears, then succeeds", async () => {
    // brain_episodes cannot go while brain_facts still references it. The retry
    // exists so the sweep does not carry a second copy of the purge's ordering.
    let factsDeleted = false;
    const query = (async (sql: string) => {
      if (sql.includes("brain_facts")) {
        factsDeleted = true;
        return [{ deleted: 1 }, { deleted: 1 }, { deleted: 1 }];
      }
      if (!factsDeleted) {
        throw new Error('update or delete on table "brain_episodes" violates foreign key constraint');
      }
      return [{ deleted: 1 }];
    }) as ResidueQuery;

    const { deletions, errors } = await executeResidueDeletes(query, [
      { table: "brain_episodes", column: "workspace_id", value: "wsAAA", rows: 1 },
      { table: "brain_facts", column: "workspace_id", value: "wsAAA", rows: 3 },
    ]);

    expect(errors).toEqual([]);
    // Unequal counts on purpose: with 1 and 1 this could not tell the two apart.
    expect(deletions.find((d) => d.table === "brain_facts")?.deletedRows).toBe(3);
    expect(deletions.find((d) => d.table === "brain_episodes")?.deletedRows).toBe(1);
  });

  test("a permanently failing delete terminates and is reported, never swallowed", async () => {
    const query = (async () => {
      throw new Error("violates foreign key constraint");
    }) as ResidueQuery;

    const { deletions, errors } = await executeResidueDeletes(query, [
      { table: "brain_episodes", column: "workspace_id", value: "wsAAA", rows: 1 },
      { table: "brain_facts", column: "workspace_id", value: "wsAAA", rows: 3 },
    ]);

    expect(deletions).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toContain("foreign key");
  });

  test("a delete that removes fewer rows than enumerated keeps BOTH numbers", async () => {
    const query = (async () => [{ deleted: 1 }]) as ResidueQuery;

    const { deletions } = await executeResidueDeletes(query, [
      { table: "crm_outbox", column: "workspace_id", value: "wsAAA", rows: 5 },
    ]);

    expect(deletions[0]).toMatchObject({ expectedRows: 5, deletedRows: 1 });
  });
});

describe("sweepResidue", () => {
  /** A fake region DB holding one sentinel and one genuine residue value. */
  const fakeRegion: ResidueQuery = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("information_schema.tables")) {
      const asked = (params?.[0] ?? []) as string[];
      return asked
        .filter((t) => t === "sla_thresholds" || t === "workspace_proactive_config")
        .map((t) => ({ table_name: t }));
    }
    if (sql.includes("information_schema.columns")) {
      return [
        { table_name: "sla_thresholds", column_name: "workspace_id", data_type: "text" },
        {
          table_name: "workspace_proactive_config",
          column_name: "workspace_id",
          data_type: "text",
        },
      ];
    }
    if (sql.startsWith("DELETE")) return [{ deleted: 1 }];
    if (sql.includes("sla_thresholds")) return [{ scope_value: "_default", row_count: "1" }];
    return [{ scope_value: "jukFiKym65bnNAYGiY1zdthspoNUYpov", row_count: "1" }];
  }) as ResidueQuery;

  test("a DRY RUN issues no DELETE", async () => {
    const statements: string[] = [];
    const spy = (async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return fakeRegion(sql, params);
    }) as ResidueQuery;

    const report = await sweepResidue(spy, { dryRun: true });

    expect(statements.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(report.wouldDelete.map((d) => d.value)).toEqual(["jukFiKym65bnNAYGiY1zdthspoNUYpov"]);
    expect(report.withheld.map((w) => w.value)).toEqual(["_default"]);
    expect(report.totals.rowsDeleted).toBe(0);
  });

  test("EXECUTE deletes the residue and NOT the sentinel's table", async () => {
    const statements: string[] = [];
    const spy = (async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return fakeRegion(sql, params);
    }) as ResidueQuery;

    const report = await sweepResidue(spy, { dryRun: false });

    const deletes = statements.filter((s) => s.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("workspace_proactive_config");
    expect(deletes.some((s) => s.includes("sla_thresholds"))).toBe(false);
    expect(report.totals.rowsDeleted).toBe(1);
    expect(report.withheld.map((w) => w.value)).toEqual(["_default"]);
  });
});

describe("quoteIdent", () => {
  test("doubles embedded quotes", () => {
    expect(quoteIdent("sla_thresholds")).toBe('"sla_thresholds"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});
