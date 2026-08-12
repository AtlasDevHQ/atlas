/**
 * GDPR purge-scope drift tripwire (#5160).
 *
 * The bug this pins: `hardDeleteWorkspace` shipped 56 `DELETE FROM` statements
 * and reached none of `brain_facts`, `brain_edges`, `brain_episodes` or
 * `knowledge_documents` — while the purge endpoint answered *"All data has been
 * irreversibly removed"* and `/dpa` promised deletion of all Personal Data.
 * Nothing forced a per-table decision, so every table added after the purge was
 * written silently escaped it. The mechanical sweep found 35 such tables.
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
const purgeFnBody = rawPurgeFnBody
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const deleteMatches = [...purgeFnBody.matchAll(/DELETE\s+FROM\s+"?([a-z_][a-z0-9_]*)"?/gi)].map(
  (m) => m[1],
);
const deleteTargets = new Set(deleteMatches);

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
    // and destroy the record of the purge, so pin the mechanism, not the label.
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
    for (const col of ["actor_id", "actor_email", "ip_address", "metadata", "target_id"]) {
      expect(
        scrub.includes(`${col} IS NULL`) || scrub.includes(`${col} = '[purged]'`),
        `the scrub's skip predicate does not check ${col} — a row already scrubbed by a ` +
          `NARROWER erasure would be skipped while still holding ${col}`,
      ).toBe(true);
    }
    expect(scrub.includes("anonymized_at IS NOT NULL")).toBe(true);
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
    const cols = columnsOf("admin_action_log").toSorted();
    expect(
      cols,
      `admin_action_log's columns changed. For each ADDED column, decide: can it carry a ` +
        `person's identity or free-form content? If yes, add it to the scrub in ` +
        `hardDeleteWorkspace's Phase 4b AND to the assertions above. If no, add it here. ` +
        `Do not just update this list — the scrub is what the purge response promises.`,
    ).toEqual(
      [
        "action_type",
        "actor_email",
        "actor_id",
        "anonymized_at",
        "id",
        "ip_address",
        "metadata",
        "org_id",
        "request_id",
        "scope",
        "status",
        "target_id",
        "target_type",
        "timestamp",
      ].toSorted(),
    );
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
      const refIdx = purgeFnBody.indexOf(`DELETE FROM ${referencing}`);
      const targetIdx = purgeFnBody.indexOf(`DELETE FROM ${target}`);
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
    // These six have no scope column, so their DELETE reads the parent's rows.
    // Deleting the parent first silently leaves them behind — no error, no
    // count, exactly the shape of the original bug.
    const childBeforeParent: Array<[string, string]> = [
      ["messages", "conversations"],
      ["slack_threads", "conversations"],
      ["dashboard_draft_card_cache", "dashboards"],
      ["dashboard_user_drafts", "dashboards"],
      ["dashboard_cards", "dashboards"],
      ["knowledge_links", "knowledge_documents"],
      ["suggestion_user_clicks", "query_suggestions"],
      ["scheduled_task_runs", "scheduled_tasks"],
      ["prompt_items", "prompt_collections"],
      ["stripe_webhook_events", "subscription"],
    ];
    for (const [child, parent] of childBeforeParent) {
      const childIdx = purgeFnBody.indexOf(`DELETE FROM ${child}`);
      const parentIdx = purgeFnBody.indexOf(`DELETE FROM ${parent}`);
      expect(childIdx, `no DELETE for ${child}`).toBeGreaterThan(-1);
      expect(parentIdx, `no DELETE for ${parent}`).toBeGreaterThan(-1);
      expect(
        childIdx,
        `${child} scopes through ${parent} via a subquery, so it must be deleted FIRST — ` +
          `otherwise the subquery finds no parent rows and ${child} is silently left behind.`,
      ).toBeLessThan(parentIdx);
    }
  });

  // ── The result contract ────────────────────────────────────────────

  it("reports a count for every purged table (operator sees what was removed)", () => {
    // AC: "HardDeleteResult reports the new counts, so the operator sees what
    // was removed rather than trusting the message." Checked structurally
    // against the interface so a new DELETE without a reported count fails.
    const resultStart = internalSource.indexOf("export interface HardDeleteResult");
    const resultEnd = internalSource.indexOf("\n}", resultStart);
    const resultFields = new Set(
      [...internalSource.slice(resultStart, resultEnd).matchAll(/^\s{2}([a-zA-Z]+):\s*number;/gm)].map(
        (m) => m[1],
      ),
    );
    expect(resultFields.size).toBeGreaterThan(80);

    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    // Plural-tolerant: the pre-existing fields are inconsistent (`subscriptions`
    // reports `subscription`), so match on a normalized stem rather than
    // demanding an exact 1:1 spelling.
    const stems = new Set([...resultFields].map((f) => snake(f).replace(/s$/, "")));
    // One table is reported under a name that is not its own, and the mismatch
    // is meaningful rather than sloppy: the purge does not clear `chat_cache`,
    // it clears the Slack installation rows INSIDE it (the
    // `value->>'orgId'` expression), so `slackInstallations` is the honest
    // label for what the count measures. Aliased explicitly so the guard stays
    // exact everywhere else instead of being loosened to accommodate it.
    const REPORTED_UNDER: Readonly<Record<string, string>> = {
      chat_cache: "slackInstallations",
    };
    const unreported = [...PURGED_TABLES].filter((t) => {
      const alias = REPORTED_UNDER[t];
      if (alias !== undefined) return !resultFields.has(alias);
      const stem = t.replace(/s$/, "");
      return !stems.has(stem) && !stems.has(t);
    });
    expect(
      unreported,
      `Purged table(s) with no count on HardDeleteResult: ${unreported.join(", ")}. ` +
        `The operator response reports these; an unreported delete is invisible.`,
    ).toEqual([]);
  });
});
