/**
 * GDPR purge-scope drift tripwire (#5160).
 *
 * The bug this pins: `hardDeleteWorkspace` shipped 57 `DELETE FROM` statements
 * and reached none of `brain_facts`, `brain_edges`, `brain_episodes` or
 * `knowledge_documents` — while the purge endpoint answered *"All data has been
 * irreversibly removed"* and `/dpa` promised deletion of all Personal Data.
 * Nothing forced a per-table decision, so every table added after the purge was
 * written silently escaped it. The mechanical sweep found 34 such tables.
 *
 * The structural reason it could not self-correct: **no table in `db/schema.ts`
 * has a foreign key to `organization`**, so `DELETE FROM organization` cascades
 * to nothing and a table is purged ONLY if it is named explicitly. This suite
 * enumerates the Drizzle schema and fails when a table appears with no entry in
 * `PURGE_TABLE_DECISIONS` — so the next brain table breaks CI rather than
 * quietly surviving a GDPR purge.
 *
 * It also pins the registry to the implementation in both directions: every
 * `purged` entry must have a real `DELETE FROM` in `hardDeleteWorkspace`, and
 * every scope-column-bearing table must have a purge-reaching decision. The
 * companion `hard-delete-purge-pg.test.ts` proves the deletes actually empty
 * the tables against a real Postgres — this file proves the enumeration is
 * complete, which no amount of row-counting can.
 *
 * Same tripwire shape as `lib/residency/__tests__/bundle-scope.test.ts` (#4460),
 * the precedent #5160 names.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import {
  PURGE_TABLE_DECISIONS,
  PURGED_TABLES,
  RETAINED_TABLES,
  WORKSPACE_SCOPE_COLUMNS,
  USER_SCOPE_COLUMNS,
  viaParentDeleteSql,
  type PurgeTableScope,
} from "../purge-scope";

// String-indexed view: the registry's literal-keyed type (via `satisfies`)
// rejects arbitrary-string indexing, which is exactly what this suite does.
const decisionFor: Readonly<Record<string, PurgeTableScope | undefined>> = PURGE_TABLE_DECISIONS;

// ── Enumerate the live schema ────────────────────────────────────────

const schemaTables = Object.values(schema).flatMap((v) =>
  is(v, PgTable) ? [getTableConfig(v)] : [],
);
const schemaTableNames = schemaTables.map((t) => t.name);

const columnsOf = (name: string): string[] =>
  schemaTables.find((t) => t.name === name)?.columns.map((c) => c.name) ?? [];

const workspaceScopeColumnOf = (name: string): string | undefined =>
  columnsOf(name).find((c) => (WORKSPACE_SCOPE_COLUMNS as readonly string[]).includes(c));

const userScopeColumnOf = (name: string): string | undefined =>
  columnsOf(name).find((c) => (USER_SCOPE_COLUMNS as readonly string[]).includes(c));

// ── Extract the purge implementation's actual DELETE targets ─────────
//
// Sliced to the function body rather than the whole file: `internal.ts` holds
// other delete paths (cascadeWorkspaceDelete), and a registry entry satisfied
// by a DELETE in a DIFFERENT function would be the precise false-pass this
// suite exists to prevent.
const internalSource = readFileSync(join(import.meta.dir, "..", "internal.ts"), "utf8");

const rawPurgeFnBody = (() => {
  const start = internalSource.indexOf("export async function hardDeleteWorkspace");
  if (start === -1) throw new Error("hardDeleteWorkspace not found in internal.ts — did it get renamed?");
  // The function's last statement is the client.release() in its finally block.
  const releaseIdx = internalSource.indexOf("client.release(rollbackErr", start);
  if (releaseIdx === -1) throw new Error("hardDeleteWorkspace's finally/release block not found");
  return internalSource.slice(start, internalSource.indexOf("\n}", releaseIdx));
})();

/**
 * COMMENTS STRIPPED — and this is not tidiness, it is the difference between a
 * guard and a decoration.
 *
 * Measured on this very PR: `DELETE FROM scim_group_mappings` appeared twice in
 * the function, once in a comment explaining the `to_regclass` probe; `DELETE
 * FROM organization` appeared three times, two of them prose. So deleting the
 * REAL statement left this suite passing 15/15, satisfied by the sentence
 * describing it — and because `-pg` suites skip silently without
 * TEST_DATABASE_URL, this tripwire is the entire completeness gate for anyone
 * running the suite locally.
 *
 * A lexical guard cannot tell a quotation from an assertion. The repo's rule for
 * that is reword-not-exempt, but here the quotations are legitimate and load
 * bearing (they explain the RESTRICT ordering and the probe), so the guard has
 * to read code rather than prose.
 */
// The line-comment strip is UNANCHORED. Anchoring it to line start (the first
// version of this fix) leaves TRAILING comments intact, so
// `const brainFacts = 0; // DELETE FROM brain_facts WHERE workspace_id = $1`
// still satisfied every check — measured, tripwire passed 18/18 with the real
// statement gone. That is the same defect one comment form over.
//
// Over-stripping is the safe direction: if this ever ate a real statement, the
// exact-count assertion and the ordering checks fail loudly rather than passing
// vacuously. Verified there is no `//` inside the function's SQL template
// literals (no URLs, no `//` in any string), so the unanchored form is safe here.
const purgeFnBody = rawPurgeFnBody
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

/**
 * The two SHAPES a delete takes in the source, and both count.
 *
 * A table with a scope column is a literal `DELETE FROM <table>`. A table with
 * none is `delViaParent("<table>")`, whose SQL is built from the registry's
 * `viaParent` declaration (#5176) and so never appears here as text.
 *
 * Scanning both keeps every check below saying what it always said — "the
 * registry cannot claim a delete the implementation does not make" — because
 * `delViaParent` is still one explicit call per table. What the registry now
 * guarantees is the RELATION, not the call: a `viaParent` entry with no call
 * site is still an entry outrunning the implementation, and still fails here.
 */
const viaParentCalls = [...purgeFnBody.matchAll(/delViaParent\("([a-z_][a-z0-9_]*)"\)/g)].map(
  (m) => m[1],
);
const deleteMatches = [
  ...[...purgeFnBody.matchAll(/DELETE\s+FROM\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]),
  ...viaParentCalls,
];
const deleteTargets = new Set(deleteMatches);

/**
 * Where a table's delete appears in the function, by whichever shape it takes.
 * The ORDER assertions below compare these positions.
 */
const deleteIndexOf = (table: string): number => {
  const viaIdx = purgeFnBody.indexOf(`delViaParent("${table}")`);
  return viaIdx !== -1 ? viaIdx : purgeFnBody.indexOf(`DELETE FROM ${table}`);
};

const updateTargets = new Set(
  [...purgeFnBody.matchAll(/UPDATE\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]),
);

/**
 * Better-Auth tables the purge deletes directly. They are not in `db/schema.ts`
 * (global by ADR-0024) so they never enter the registry, but they ARE real
 * DELETE targets, so the exact-count assertion has to know about them.
 */
const BETTER_AUTH_DELETE_TARGETS = new Set([
  "organization",
  "member",
  "invitation",
  "session",
  "account",
  "user",
]);

/**
 * The one `user_scoped` table with no DELETE of its own: the migration-level
 * `"user"(id) ON DELETE CASCADE` in `0048_trusted_device.sql` removes it when
 * the orphaned user row goes. Named as a single table rather than exempting the
 * whole `user_scoped` category, so the next addition has to justify itself.
 */
const FK_CASCADE_ONLY = new Set(["trusted_device"]);

/** Tables the purge deletes for orphaned users, keyed on the user rather than the org. */
const USER_SCOPED_DELETE_TARGETS = Object.entries(PURGE_TABLE_DECISIONS)
  .filter(([, v]) => v.decision === "user_scoped")
  .map(([k]) => k)
  .filter((t) => !FK_CASCADE_ONLY.has(t));

describe("GDPR purge-scope drift tripwire (#5160)", () => {
  it("enumerates a plausible schema (sanity: the known pillars are present)", () => {
    // Guards the enumeration itself — if the Drizzle introspection came back
    // empty, every other assertion below would vacuously pass.
    expect(schemaTableNames.length).toBeGreaterThan(90);
    for (const known of [
      "conversations",
      "brain_facts",
      "knowledge_documents",
      "dashboards",
      "semantic_entities",
    ]) {
      expect(schemaTableNames).toContain(known);
    }
  });

  it("parses the purge implementation (sanity: the DELETE scan found the known targets)", () => {
    // Same guard one layer over: a regex that matched nothing would make
    // "every purged table has a DELETE" fail loudly rather than pass, but a
    // regex that matching a PREFIX of the statements would silently weaken the
    // registry-vs-implementation check. Pinned to the exact count rather than a
    // floor — a floor of 80 against 95 actual leaves room for a refactor to lose
    // 14 statements silently. Update this number deliberately when adding one.
    expect(deleteTargets.size).toBe(
      PURGED_TABLES.size + USER_SCOPED_DELETE_TARGETS.length + BETTER_AUTH_DELETE_TARGETS.size,
    );
    for (const known of ["conversations", "brain_facts", "knowledge_documents", "organization"]) {
      expect([...deleteTargets]).toContain(known);
    }
  });

  it("scopes every DELETE by the workspace ALONE — no status/state narrowing", () => {
    // A purge DELETE may filter by the workspace (or a parent subquery). It may
    // NOT narrow further on a status, kind or state column, because such a
    // predicate silently leaves the rows in every other state behind while the
    // count still reads non-zero and the response still says "irreversibly
    // deleted".
    //
    // This forbids the SHAPE rather than detecting one instance, which is the
    // stronger guard and the reason it is here rather than in the -pg suite:
    // measured, `DELETE FROM knowledge_documents WHERE workspace_id = $1 AND
    // status = 'published'` — which under the draft-first model (ADR-0029/0034)
    // abandons most of a workspace's knowledge base — passed all three suites,
    // because the fixture seeds exactly one row per table and COLUMN_OVERRIDES
    // pins its status to a single value. Making the fixture disprove that needs
    // a second row per table with a distinct key, which the seeder's key
    // synthesis cannot currently produce; forbidding the predicate costs one
    // regex and covers every table at once.
    //
    // `chat_cache` is the deliberate exception: its scope IS an expression
    // (`key LIKE 'slack:installation:%' AND value->>'orgId' = $1`), and the LIKE
    // is what identifies the workspace's rows rather than narrowing them.
    const NARROWING = /\b(status|state|kind|type|level|verdict|tier|mode)\s*(=|<>|!=|IN)\s*'/i;
    const offenders: string[] = [];
    for (const stmt of purgeFnBody.split("DELETE FROM ").slice(1)) {
      const clause = stmt.slice(0, stmt.indexOf("`") === -1 ? stmt.length : stmt.indexOf("`"));
      const table = clause.match(/^"?([a-z_][a-z0-9_]*)"?/i)?.[1] ?? "?";
      if (table === "chat_cache") continue;
      const m = clause.match(NARROWING);
      if (m) offenders.push(`${table} (narrowed on \`${m[0]}…\`)`);
    }
    // The ten `viaParent` tables have no literal statement to slice (#5176), so
    // their SQL is GENERATED here from the same registry declaration and builder
    // the implementation uses — checking the builder's real output rather than a
    // restatement of it. If a narrowing predicate ever became expressible in the
    // link (a `where?:` field, say), it would appear here.
    for (const [table, entry] of Object.entries(decisionFor)) {
      if (!entry?.viaParent) continue;
      const m = viaParentDeleteSql(table, entry.viaParent).match(NARROWING);
      if (m) offenders.push(`${table} (viaParent SQL narrowed on \`${m[0]}…\`)`);
    }
    expect(
      offenders,
      `DELETE(s) narrowed by a state column: ${offenders.join(", ")}. A purge must remove ` +
        `ALL of a workspace's rows in a table, not the ones in one state — the rest survive ` +
        `silently under a non-zero count and an "irreversibly deleted" response.`,
    ).toEqual([]);
  });

  it("issues EXACTLY ONE DELETE per table (a duplicate hides a stray statement)", () => {
    // The check that would have caught this PR's own comment-satisfied scan
    // independently of the comment strip: `scim_group_mappings` and
    // `organization` both resolved twice before the fix. It also catches the
    // reverse mistake — the same table deleted under two different predicates,
    // where only one of them is scoped correctly.
    const counts = new Map<string, number>();
    for (const t of deleteMatches) counts.set(t, (counts.get(t) ?? 0) + 1);
    const duplicated = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([t, n]) => `${t} (${n}×)`);
    expect(
      duplicated,
      `Table(s) with more than one DELETE FROM in hardDeleteWorkspace: ${duplicated.join(", ")}. ` +
        `If that is deliberate, say why here; if it is a comment, the strip above should have ` +
        `removed it; if it is a stray statement, remove it.`,
    ).toEqual([]);
  });

  it("every schema table has an explicit purge decision (new table ⇒ decide before merge)", () => {
    const undecided = schemaTableNames.filter((name) => !(name in PURGE_TABLE_DECISIONS));
    expect(
      undecided,
      `New table(s) with no GDPR purge decision: ${undecided.join(", ")}.\n` +
        `Add each to PURGE_TABLE_DECISIONS in lib/db/purge-scope.ts. If the table carries ` +
        `org_id / workspace_id / reference_id it is workspace data and almost certainly ` +
        `'purged' — wire a DELETE into hardDeleteWorkspace and report its count on ` +
        `HardDeleteResult. NOTE: nothing in db/schema.ts has an FK to \`organization\`, so ` +
        `\`DELETE FROM organization\` will NOT cascade to your table.`,
    ).toEqual([]);
  });

  it("has no stale registry entries for dropped tables", () => {
    const stale = Object.keys(PURGE_TABLE_DECISIONS).filter(
      (name) => !schemaTableNames.includes(name),
    );
    expect(
      stale,
      `Registry entries for tables no longer in db/schema.ts: ${stale.join(", ")}. ` +
        `Remove them from PURGE_TABLE_DECISIONS (and their DELETE from hardDeleteWorkspace).`,
    ).toEqual([]);
  });

  it("every decision carries a non-empty rationale", () => {
    for (const [name, entry] of Object.entries(PURGE_TABLE_DECISIONS)) {
      expect(entry.reason.trim().length, `${name} has an empty reason`).toBeGreaterThan(0);
    }
  });

  // ── The load-bearing guard: scoped ⇒ reachable ──────────────────────

  it("every workspace-scoped table has a purge-reaching decision, never 'platform'", () => {
    // THE #5160 guard. A table carrying org_id/workspace_id/reference_id is
    // workspace data by construction, so classifying it 'platform' (or
    // 'user_scoped') would be the exact mistake that let 35 tables through.
    // 'retained' and 'anonymized' are permitted but must justify themselves —
    // the reason field is checked above, and each is spot-pinned below.
    const misclassified = schemaTableNames
      .filter((name) => workspaceScopeColumnOf(name) !== undefined)
      .filter((name) => {
        const d = decisionFor[name]?.decision;
        return d === "platform" || d === "user_scoped";
      });
    expect(
      misclassified,
      `Workspace-scoped table(s) classified as out-of-scope for the purge: ` +
        `${misclassified.map((n) => `${n} (${workspaceScopeColumnOf(n)})`).join(", ")}. ` +
        `A table with a workspace scope column holds tenant data — it must be 'purged', ` +
        `or 'retained'/'anonymized' with a reason naming the concrete harm deleting it causes.`,
    ).toEqual([]);
  });

  it("every 'purged' table is actually deleted by hardDeleteWorkspace", () => {
    // Closes the direction bundle-scope's precedent closes: the registry cannot
    // claim coverage the implementation does not provide.
    const claimed = [...PURGED_TABLES].filter((t) => !deleteTargets.has(t));
    expect(
      claimed,
      `Table(s) marked 'purged' with no DELETE FROM in hardDeleteWorkspace: ` +
        `${claimed.join(", ")}. Either add the DELETE (and its HardDeleteResult count) ` +
        `or change the decision.`,
    ).toEqual([]);
  });

  it("every table hardDeleteWorkspace deletes is registered as 'purged'", () => {
    // The reverse direction: an unregistered DELETE means the registry is no
    // longer a faithful description of the purge, which is how it would rot
    // back into a list nobody trusts. Better-Auth tables are not in
    // db/schema.ts (global by ADR-0024) and never enter this registry.
    // `user_scoped` is a legitimate second answer, not a loophole: the purge
    // DOES delete user_onboarding and email_preferences, but only for users
    // orphaned by the member removal, keyed on the user id rather than the org.
    const deletableDecisions = new Set(["purged", "user_scoped"]);
    const unregistered = [...deleteTargets]
      .filter((t) => !BETTER_AUTH_DELETE_TARGETS.has(t))
      .filter((t) => !deletableDecisions.has(decisionFor[t]?.decision ?? ""));
    expect(
      unregistered,
      `hardDeleteWorkspace deletes table(s) not registered as 'purged' or 'user_scoped': ` +
        `${unregistered.join(", ")}. Add them to PURGE_TABLE_DECISIONS.`,
    ).toEqual([]);
  });

  it("the 'anonymized' table is UPDATEd, not deleted", () => {
    // admin_action_log's whole point is that the row survives. A future edit
    // that "simplified" the scrub into a DELETE would satisfy the reason field
    // and destroy the record of what operators previously did to this
    // workspace, so pin the mechanism, not the label.
    const anonymized = Object.entries(PURGE_TABLE_DECISIONS)
      .filter(([, v]) => v.decision === "anonymized")
      .map(([k]) => k);
    expect(anonymized).toEqual(["admin_action_log"]);
    for (const table of anonymized) {
      expect(updateTargets.has(table), `${table} is 'anonymized' but never UPDATEd`).toBe(true);
      expect(deleteTargets.has(table), `${table} is 'anonymized' but DELETEd`).toBe(false);
    }
    // The scrub must null every personal-data column, not just the obvious two.
    // Bounded to the statement: an unbounded slice to end-of-function would be
    // satisfied by ANY later statement mentioning these columns, which is the
    // same lexical over-reach the comment strip above exists to close.
    const scrubStart = purgeFnBody.indexOf("UPDATE admin_action_log");
    expect(scrubStart).toBeGreaterThan(-1);
    const scrub = purgeFnBody.slice(scrubStart, purgeFnBody.indexOf("`", scrubStart + 1));
    // Every column on admin_action_log that can carry a person's identity —
    // including the two that are NOT obvious, and which the first draft of this
    // fix missed: `metadata` (admin-mfa-reset writes targetUserEmail into it)
    // and `target_id` (a user id on any user-targeted action).
    for (const col of ["actor_id", "actor_email", "ip_address"]) {
      expect(scrub.includes(`${col} = NULL`), `admin_action_log scrub misses ${col}`).toBe(true);
    }
    expect(scrub.includes("metadata = NULL"), "admin_action_log scrub misses metadata").toBe(true);
    expect(scrub.includes("target_id ="), "admin_action_log scrub misses target_id").toBe(true);
    expect(scrub.includes("anonymized_at = now()")).toBe(true);
    // The skip predicate must be a RESIDUE check covering every column the SET
    // list touches — not `anonymized_at IS NULL`. A timestamp check drifts out
    // of step the moment the SET list grows: F-36 stamps `anonymized_at` after
    // nulling only the actor columns, so a row it touched would be skipped here
    // and keep `metadata`/`target_id` through a completed purge. Every column
    // set above must also appear in the predicate.
    // ⚠️ Sliced to the WHERE clause, and that slice is the whole assertion.
    // Measured: checking against the FULL statement, `target_id = '[purged]'`
    // was satisfied by the SET clause that writes exactly that string — so
    // deleting `AND target_id = '[purged]'` from the predicate passed all three
    // suites. The other four columns were safe only by spelling accident (`= NULL`
    // in the SET vs `IS NULL` in the WHERE); `target_id` is the one column where
    // the two forms collide. Slicing fixes all five uniformly instead of
    // special-casing the one that bit.
    const whereIdx = scrub.indexOf("WHERE");
    expect(whereIdx, "the scrub has no WHERE clause").toBeGreaterThan(-1);
    const scrubWhere = scrub.slice(whereIdx);
    for (const col of ["actor_id", "actor_email", "ip_address", "metadata", "target_id"]) {
      expect(
        scrubWhere.includes(`${col} IS NULL`) || scrubWhere.includes(`${col} = '[purged]'`),
        `the scrub's skip PREDICATE does not check ${col} — a row already scrubbed by a ` +
          `NARROWER erasure (F-36 nulls only the actor columns) would be skipped while ` +
          `still holding ${col}`,
      ).toBe(true);
    }
    expect(scrubWhere.includes("anonymized_at IS NOT NULL")).toBe(true);
    // The scrub must stay org-scoped. `admin_action_log.org_id` is NULLABLE —
    // platform-scope operator actions carry NULL — so a predicate broadened to
    // `OR org_id IS NULL` would let every workspace purge quietly strip the
    // identity columns off the entire platform-wide operator trail.
    expect(
      scrubWhere.includes("org_id IS NULL"),
      "the scrub must NOT match NULL-org rows — those are platform-scope operator actions, " +
        "not this workspace's data",
    ).toBe(false);
  });

  it("has exactly one 'anonymized' table, so the survivor-exclusion list stays complete", () => {
    // `SURVIVOR_COUNT_FIELDS` in internal.ts is an opt-OUT list: `satisfies`
    // makes a rename a compile error, but an OMISSION is nothing at all. If a
    // second table becomes `anonymized` and its count is not added to that list,
    // `totalRowsDeleted` silently sums surviving rows into "rows irreversibly
    // destroyed" — reopening #5160's overstatement one table over, on the number
    // an operator puts in a DPA erasure record.
    //
    // Pinning the count to one is the cheap guard: growing the category fails
    // here and the message says what else has to change.
    const anonymized = Object.entries(PURGE_TABLE_DECISIONS)
      .filter(([, v]) => v.decision === "anonymized")
      .map(([k]) => k);
    expect(
      anonymized,
      `The 'anonymized' category grew. Each anonymized table needs (a) a survivor count on ` +
        `HardDeleteResult, (b) an entry in SURVIVOR_COUNT_FIELDS so totalRowsDeleted excludes ` +
        `it, and (c) its own scrub assertions here. Update this list LAST, once those exist.`,
    ).toEqual(["admin_action_log"]);

    // And the exclusion list in the implementation must name exactly that table's
    // count field — read from source, the same way the DELETE checks are.
    const survivorBlock = internalSource.slice(
      internalSource.indexOf("const SURVIVOR_COUNT_FIELDS"),
      internalSource.indexOf(");", internalSource.indexOf("const SURVIVOR_COUNT_FIELDS")),
    );
    expect(survivorBlock).toContain("adminActionLogAnonymized");
  });

  it("pins admin_action_log's full column list, so a new column forces a scrub decision", () => {
    // THE RATCHET (Step 5b). The scrub had to be widened once already — the
    // first draft nulled actor_id/actor_email/ip_address and left
    // `metadata.targetUserEmail` and `target_id` holding a purged workspace's
    // member emails, under a response that said the identifiers were gone. A
    // pinned scrub-column list cannot notice the NEXT identity-bearing column,
    // so pin the TABLE instead: adding a column to admin_action_log fails here
    // and the author has to say whether it survives a purge.
    //
    // The failure message is the whole value — it asks the question rather than
    // just reporting a mismatch.
    // TWO buckets, not one flat list. A flat list is satisfied by appending the
    // new column's name — the cheapest path to green is exactly the one that
    // skips the decision. Splitting it means a new column has to be classified,
    // and the SCRUBBED bucket is then checked against the real SET list by the
    // per-column loop above, so putting it in the wrong bucket also fails.
    const SCRUBBED = [
      "actor_id",
      "actor_email",
      "ip_address",
      "metadata",
      "target_id",
      "anonymized_at",
    ];
    const SURVIVES_PURGE = [
      "action_type",
      "id",
      "org_id",
      "request_id",
      "scope",
      "status",
      "target_type",
      "timestamp",
    ];
    const cols = columnsOf("admin_action_log").toSorted();
    expect(
      cols,
      `admin_action_log's columns changed. Put each ADDED column in exactly one bucket ` +
        `in this test: SCRUBBED (it can carry a person's identity or free-form content) or ` +
        `SURVIVES_PURGE (it cannot). If SCRUBBED, wire it into BOTH scrubs — ` +
        `hardDeleteWorkspace's Phase 4b (SET list AND skip predicate) in lib/db/internal.ts, ` +
        `and the per-user right-to-erasure scrub in ee/src/audit/retention.ts. There are TWO, ` +
        `and #5160 found them already divergent: the per-user path (the stronger Article 17 ` +
        `obligation) was clearing strictly less than the bulk purge. Appending to the wrong ` +
        `bucket fails the per-column assertions above, which is the point — the scrub is what ` +
        `the purge response promises.`,
    ).toEqual([...SCRUBBED, ...SURVIVES_PURGE].toSorted());

    // Every column claimed as SCRUBBED must really be in the scrub's SET list.
    const scrubStart = purgeFnBody.indexOf("UPDATE admin_action_log");
    const setBlock = purgeFnBody.slice(scrubStart, purgeFnBody.indexOf("WHERE", scrubStart));
    for (const col of SCRUBBED) {
      expect(setBlock.includes(`${col} =`), `${col} is bucketed SCRUBBED but the SET list omits it`).toBe(true);
    }
  });

  it("no 'retained' table is deleted, and each names a concrete harm", () => {
    for (const table of RETAINED_TABLES) {
      expect(
        deleteTargets.has(table),
        `${table} is 'retained' but hardDeleteWorkspace deletes it`,
      ).toBe(false);
    }
    // Pinned by name: retention is the one decision that leaves tenant-adjacent
    // rows behind, so adding to this set is a deliberate act, not a default.
    expect([...RETAINED_TABLES].toSorted()).toEqual([
      "stripe_purged_subscriptions",
      "stripe_teardown_pending",
      "user_trial_grants",
    ]);
  });

  it("every 'user_scoped' table is keyed on a user, not a workspace", () => {
    const kinds = Object.entries(PURGE_TABLE_DECISIONS).filter(
      ([, v]) => v.decision === "user_scoped",
    );
    expect(kinds.length).toBeGreaterThan(0);
    for (const [name] of kinds) {
      expect(
        userScopeColumnOf(name),
        `${name} is 'user_scoped' but has no user_id column`,
      ).toBeDefined();
    }
  });

  it("every 'user_scoped' table is either DELETEd or removed by a documented FK cascade", () => {
    // The direction this suite was missing: it checked `purged` ⇒ has a DELETE,
    // but nothing checked the same for `user_scoped`, so removing
    // `DELETE FROM user_onboarding` or its `email_preferences` twin was
    // invisible to BOTH suites — an orphaned user kept their tour state and
    // email preferences after their account was erased.
    //
    // `trusted_device` is the one legitimate exception (see FK_CASCADE_ONLY).
    const unreached = USER_SCOPED_DELETE_TARGETS.filter((t) => !deleteTargets.has(t));
    expect(
      unreached,
      `'user_scoped' table(s) with no DELETE in hardDeleteWorkspace: ${unreached.join(", ")}. ` +
        `Either add the orphaned-user DELETE or record the FK cascade that removes it.`,
    ).toEqual([]);
  });

  it("every 'platform' table is unscoped in both dimensions", () => {
    const wrong = Object.entries(PURGE_TABLE_DECISIONS)
      .filter(([, v]) => v.decision === "platform")
      .map(([k]) => k)
      .filter((name) => workspaceScopeColumnOf(name) !== undefined);
    expect(
      wrong,
      `Table(s) marked 'platform' that carry a workspace scope column: ${wrong.join(", ")}.`,
    ).toEqual([]);
  });

  // ── Order constraints the purge transaction depends on ──────────────

  it("deletes RESTRICT-referencing tables before their targets", () => {
    // brain_facts → brain_episodes and brain_vocabulary_target →
    // brain_vocabulary_edge are ON DELETE RESTRICT, not CASCADE. Getting the
    // order wrong does not lose rows — it aborts the ENTIRE purge transaction,
    // so a workspace could be soft-deleted and never purgeable. That failure
    // needs a real Postgres to reproduce, but the ORDER is checkable here.
    const restrictPairs: Array<[string, string]> = [
      ["brain_facts", "brain_episodes"],
      ["brain_vocabulary_target", "brain_vocabulary_edge"],
    ];
    for (const [referencing, target] of restrictPairs) {
      const refIdx = deleteIndexOf(referencing);
      const targetIdx = deleteIndexOf(target);
      expect(refIdx, `no DELETE for ${referencing}`).toBeGreaterThan(-1);
      expect(targetIdx, `no DELETE for ${target}`).toBeGreaterThan(-1);
      expect(
        refIdx,
        `${referencing} must be deleted BEFORE ${target} — the FK between them is ` +
          `ON DELETE RESTRICT, so the reverse order aborts the purge transaction.`,
      ).toBeLessThan(targetIdx);
    }
  });

  it("deletes child tables that scope via a parent subquery before that parent", () => {
    // None of these has a scope column, so their DELETE reads the parent's rows.
    // Deleting the parent first silently leaves them behind — no error, no
    // count, exactly the shape of the original bug.
    //
    // The pairs are READ FROM THE REGISTRY (#5176). They used to be a
    // hand-written list here, a third independent copy of the same relation
    // alongside the SQL and the -pg falsifier's map — each self-consistent, so a
    // drifted one still passed its own suite. This list can no longer disagree
    // with the SQL, because the SQL is generated from what it iterates.
    //
    // What it still checks, and what makes it able to fail, is the ORDER: the
    // registry says nothing about where in the function a delete is issued, so
    // moving `delViaParent("messages")` below `DELETE FROM conversations` fails
    // here by name.
    const childBeforeParent = Object.entries(decisionFor).flatMap(([child, entry]) =>
      entry?.viaParent ? [[child, entry.viaParent.parent] as const] : [],
    );
    expect(
      childBeforeParent.length,
      "no viaParent declarations found — this test would be vacuous",
    ).toBe(10);
    for (const [child, parent] of childBeforeParent) {
      const childIdx = deleteIndexOf(child);
      const parentIdx = deleteIndexOf(parent);
      expect(childIdx, `no delete for ${child}`).toBeGreaterThan(-1);
      expect(parentIdx, `no delete for ${parent}`).toBeGreaterThan(-1);
      expect(
        childIdx,
        `${child} scopes through ${parent} via a subquery, so it must be deleted FIRST — ` +
          `otherwise the subquery finds no parent rows and ${child} is silently left behind.`,
      ).toBeLessThan(parentIdx);
    }
  });

  it("declares viaParent on exactly the purged tables with no scope column", () => {
    // The registry's `viaParent` is now what routes a table through its parent,
    // so the set has to match the tables that need routing — in BOTH directions.
    // A scope-less table with no declaration is unreachable by the purge (the
    // #5160 bug); a declaration on a table that has its own scope column is a
    // subquery doing the work a `WHERE org_id = $1` would do directly, which is
    // slower and drifts.
    //
    // `chat_cache` is the one legitimate scope-less table without one: it is
    // scoped by an EXPRESSION (`key LIKE … AND value->>'orgId' = $1`), not by a
    // parent row. Named singly so the next addition has to justify itself.
    const EXPRESSION_SCOPED = new Set(["chat_cache"]);
    const wrong: string[] = [];
    for (const table of PURGED_TABLES) {
      const declared = decisionFor[table]?.viaParent !== undefined;
      const scoped = workspaceScopeColumnOf(table) !== undefined;
      if (scoped && declared) wrong.push(`${table} (has ${workspaceScopeColumnOf(table)}, but declares viaParent)`);
      if (!scoped && !declared && !EXPRESSION_SCOPED.has(table)) {
        wrong.push(`${table} (no scope column and no viaParent — nothing reaches it)`);
      }
    }
    expect(
      wrong,
      `viaParent declared on the wrong tables: ${wrong.join(", ")}.`,
    ).toEqual([]);
  });

  it("matches the schema's own foreign key wherever one exists", () => {
    // ⚠️ THE CHECK THAT KEEPS THE -pg FALSIFIER HONEST, and the reason it is
    // here rather than there.
    //
    // Collapsing the relation to one declaration (#5176) removed three copies
    // that could disagree — but it also means the seeder and the purge now read
    // the SAME declaration, so a declaration that is WRONG but internally
    // consistent satisfies both. Measured: pointing `messages` at `dashboards`
    // makes the seeder insert a dashboard id and the purge delete by the same
    // join, and the -pg suite stays green while the production DELETE would
    // match nothing. That is "fixtures that agree by construction" arriving
    // through the fix for it.
    //
    // The FK in db/schema.ts is the independent third party. It is written from
    // the migrations, nothing here can edit it to agree, and seven of the ten
    // declarations have one — so for those, a mis-pointed parent fails HERE.
    //
    // The three without a single-column FK are pinned by value below, because
    // there is nothing to derive them from. Each says why.
    const NO_SINGLE_COLUMN_FK: Readonly<Record<string, { parent: string; parentKey: string }>> = {
      // Deliberately no FK — the registry entry says so ("no FK to cascade
      // from"). The mapping exists only in the purge's own subquery.
      slack_threads: { parent: "conversations", parentKey: "id" },
      // `subscription` is a @better-auth/stripe table created by migration 0152,
      // not declared in db/schema.ts, so no Drizzle FK can reference it.
      stripe_webhook_events: { parent: "subscription", parentKey: "stripeSubscriptionId" },
      // Its FK is COMPOSITE, to dashboard_user_drafts(user_id, dashboard_id).
      // The purge deliberately routes it to the GRANDPARENT `dashboards`
      // instead — a `dashboard_id` subquery reaches every draft's cache in one
      // statement, and neither this table nor its parent carries a scope column
      // to narrow on.
      dashboard_draft_card_cache: { parent: "dashboards", parentKey: "id" },
    };

    const fksOf = (table: string) =>
      schemaTables
        .find((t) => t.name === table)
        ?.foreignKeys.map((fk) => {
          const ref = fk.reference();
          return {
            columns: ref.columns.map((c) => c.name),
            foreignTable: getTableConfig(ref.foreignTable).name,
            foreignColumns: ref.foreignColumns.map((c) => c.name),
          };
        }) ?? [];

    const wrong: string[] = [];
    let checkedAgainstFk = 0;
    for (const [child, entry] of Object.entries(decisionFor)) {
      const link = entry?.viaParent;
      if (!link) continue;
      const fk = fksOf(child).find((f) => f.columns.length === 1 && f.columns[0] === link.column);
      if (!fk) {
        const pinned = NO_SINGLE_COLUMN_FK[child];
        if (!pinned) {
          wrong.push(
            `${child}.${link.column} has no single-column FK and is not pinned — add it to ` +
              `NO_SINGLE_COLUMN_FK with the reason no FK exists`,
          );
        } else if (pinned.parent !== link.parent || pinned.parentKey !== link.parentKey) {
          wrong.push(
            `${child} declares ${link.parent}(${link.parentKey}) but is pinned to ` +
              `${pinned.parent}(${pinned.parentKey})`,
          );
        }
        continue;
      }
      checkedAgainstFk++;
      if (fk.foreignTable !== link.parent || fk.foreignColumns[0] !== link.parentKey) {
        wrong.push(
          `${child}.${link.column} has an FK to ${fk.foreignTable}(${fk.foreignColumns[0]}) but ` +
            `viaParent declares ${link.parent}(${link.parentKey})`,
        );
      }
    }
    expect(
      wrong,
      `viaParent declaration(s) disagreeing with the schema: ${wrong.join("; ")}`,
    ).toEqual([]);
    // Guards this test against becoming an empty loop if `viaParent` is renamed
    // or the FK introspection changes shape.
    expect(checkedAgainstFk, "no declaration was checked against a real FK").toBe(7);
  });

  it("names a real column on a real parent in every viaParent declaration", () => {
    // The registry is a plain data file, so a typo in `column`/`parentKey`/
    // `parentScope` is only caught where the names meet the schema. Checked
    // against the live Drizzle enumeration, which is the same source the
    // "every schema table has a decision" tripwire reads.
    const bad: string[] = [];
    for (const [child, entry] of Object.entries(decisionFor)) {
      const link = entry?.viaParent;
      if (!link) continue;
      // `subscription` is a @better-auth/stripe table, created by migration 0152
      // rather than declared in db/schema.ts, so the enumeration cannot see it.
      if (link.parent === "subscription") continue;
      if (!columnsOf(child).includes(link.column)) bad.push(`${child}.${link.column} does not exist`);
      if (!schemaTableNames.includes(link.parent)) bad.push(`${child}: parent ${link.parent} is not a table`);
      if (!columnsOf(link.parent).includes(link.parentKey)) {
        bad.push(`${child}: ${link.parent}.${link.parentKey} does not exist`);
      }
      if (!columnsOf(link.parent).includes(link.parentScope)) {
        bad.push(`${child}: ${link.parent}.${link.parentScope} does not exist`);
      }
    }
    expect(bad, `viaParent declaration(s) naming something the schema does not have: ${bad.join("; ")}`).toEqual([]);
  });

  // ── The result contract ────────────────────────────────────────────
  //
  // "reports a count for every purged table" USED to live here: it sliced
  // `HardDeleteResult`'s own source with a regex, normalized plural stems, and
  // consulted a `REPORTED_UNDER` alias map to excuse `chat_cache`. #5176 deleted
  // it rather than adapting it, because `HardDeleteCounts` is now a mapped type
  // over this registry — a `purged` entry with no count is a compile error at
  // `hardDeleteWorkspace`'s return statement (measured: TS2741, "Property
  // 'falsifierNewTable' is missing"), a misspelled field is TS2561, and the two
  // aliases are members of the type instead of entries in a test's lookup.
  //
  // A test that still passed after that type landed would no longer be the thing
  // enforcing the rule, and keeping it would suggest otherwise. What the type
  // CANNOT express stays above: that the DELETE exists at all, the delete ORDER
  // the two RESTRICT FKs depend on, and the scrub's residue predicate.
});
