/**
 * Better Auth purge/bundle-scope tripwire (#5515) — the enumeration the
 * Drizzle-schema tripwires cannot perform.
 *
 * `purge-scope.test.ts` and `bundle-scope.test.ts` enumerate `db/schema.ts`
 * and fail when a table appears with no decision. Better Auth tables are
 * absent from that schema BY DESIGN (their DDL is owned by better-auth's
 * schema-diff auto-migrate), so the guard could not see the class — which is
 * how @better-auth/scim 1.7's catalog (#5505) arrived as NINE tables, several
 * carrying customer names and emails verbatim (`scimUser.primaryEmail`,
 * `scimIdentityTombstone.profile`), with zero entries in either registry and
 * nothing failing. The issue's own words: "the guard cannot see the class."
 *
 * This suite enumerates the class from its real source of truth:
 * `getAuthTables({ plugins: buildPlugins() })` — the exact merge better-auth's
 * migrator generates DDL from, over the exact plugin roster production runs
 * (SCIM included, via the enterprise flag set below). A plugin bump that adds
 * a table therefore fails HERE, by name, until it carries a decision in BOTH
 * `BETTER_AUTH_PURGE_DECISIONS` and `BETTER_AUTH_BUNDLE_DECISIONS`.
 *
 * It also pins the registry to the implementation, the same two directions the
 * Drizzle tripwire pins:
 *  - `purged`  ⇒ a real workspace-scoped `DELETE FROM "<table>"` exists in
 *    `hardDeleteWorkspace`, in an order that respects the child-via-parent
 *    subqueries;
 *  - `explicit-delete` ⇒ a real orphan-arm DELETE exists;
 *  - a `purged` entry that ALSO declares `orphanArm` ⇒ TWO statements, not
 *    one satisfying both of the checks above (#5525);
 *  - `user_scoped`/`user-fk-cascade` ⇒ the plugin schema actually declares
 *    the user reference the entry's mechanism claims (better-auth's migrator
 *    defaults `onDelete` to CASCADE — get-migration.mjs:
 *    `onDelete(field.references.onDelete || "cascade")` — so a declared
 *    reference IS a cascade unless it says otherwise);
 *  - `unreached` is pinned to its exact membership, so the easy arm can only
 *    grow deliberately.
 *
 * The behavioral half — the deletes actually emptying real tables, the
 * multi-workspace `scimUser` case, the blast radius — lives in
 * `scim-purge-pg.test.ts` against a real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { getAuthTables } from "better-auth/db";
import { buildPlugins } from "@atlas/api/lib/auth/server";
import {
  BETTER_AUTH_PURGE_DECISIONS,
  BETTER_AUTH_PURGED_TABLES,
  BETTER_AUTH_ORPHAN_DELETE_TABLES,
  BETTER_AUTH_DUAL_ARM_TABLES,
  PURGE_TABLE_DECISIONS,
  SCIM_PLUGIN_TABLES,
  type BetterAuthTableScope,
} from "../purge-scope";
import { BUNDLE_TABLE_DECISIONS, BETTER_AUTH_BUNDLE_DECISIONS } from "@atlas/api/lib/residency/bundle-scope";

// String-indexed views, for the same reason purge-scope.test.ts has one: the
// literal-keyed registry types reject arbitrary-string indexing.
const purgeDecisionFor: Readonly<Record<string, BetterAuthTableScope | undefined>> =
  BETTER_AUTH_PURGE_DECISIONS;
const bundleDecisionFor: Readonly<Record<string, { decision: string; reason: string } | undefined>> =
  BETTER_AUTH_BUNDLE_DECISIONS;

/**
 * `@better-auth/stripe` is the one plugin this roster cannot enable: it is
 * gated on STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + a live internal DB,
 * none of which a unit test should stand up. Its single table is the
 * deliberate exception to the whole class: `subscription` is mirrored into
 * `db/schema.ts` precisely so the drift gates can see it, which puts it in
 * BOTH Drizzle registries already — asserted below, so the exemption is a
 * verified fact rather than a hole.
 */
const STRIPE_GATED_TABLES = ["subscription"] as const;

interface EnumeratedField {
  references?: { model: string; field: string; onDelete?: string };
}

interface EnumeratedTable {
  modelName: string;
  fields: Record<string, EnumeratedField>;
}

let enumerated: EnumeratedTable[] = [];

let priorEnterpriseFlag: string | undefined;
let priorAuthSecret: string | undefined;

beforeAll(() => {
  // SCIM is behind `isEnterpriseEnabled()` and `buildPlugins()` derives the
  // SCIM credential-hash secret from BETTER_AUTH_SECRET — same provisioning
  // as auth-endpoint-key-collisions.test.ts, restored in afterAll.
  priorEnterpriseFlag = process.env.ATLAS_ENTERPRISE_ENABLED;
  process.env.ATLAS_ENTERPRISE_ENABLED = "true";
  priorAuthSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET ??= "test-auth-secret-at-least-32-chars-long!!";

  const tables = getAuthTables({ plugins: buildPlugins() });
  enumerated = Object.values(tables).map((t) => ({
    modelName: t.modelName,
    fields: t.fields as Record<string, EnumeratedField>,
  }));
});

afterAll(() => {
  if (priorEnterpriseFlag === undefined) delete process.env.ATLAS_ENTERPRISE_ENABLED;
  else process.env.ATLAS_ENTERPRISE_ENABLED = priorEnterpriseFlag;
  if (priorAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = priorAuthSecret;
});

// ── The purge implementation, sliced and comment-stripped ─────────────
//
// The same technique as purge-scope.test.ts, and the strip matters for the
// same measured reason: table names appear in comments explaining the probes,
// and a scan that reads prose is satisfied by the sentence describing a
// deleted statement.
const internalSource = readFileSync(join(import.meta.dir, "..", "internal.ts"), "utf8");

const rawPurgeFnBody = (() => {
  const start = internalSource.indexOf("export async function hardDeleteWorkspace");
  if (start === -1) throw new Error("hardDeleteWorkspace not found in internal.ts — renamed?");
  const releaseIdx = internalSource.indexOf("client.release(rollbackErr", start);
  if (releaseIdx === -1) throw new Error("hardDeleteWorkspace's finally/release block not found");
  return internalSource.slice(start, internalSource.indexOf("\n}", releaseIdx));
})();

const purgeFnBody = rawPurgeFnBody
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

const deleteIndexOf = (table: string): number =>
  purgeFnBody.search(new RegExp(`DELETE FROM "?${table}"?\\b`));

describe("Better Auth purge/bundle-scope tripwire (#5515)", () => {
  it("enumerates a plausible plugin roster (sanity: the known tables are present)", () => {
    // Guards the enumeration itself — an empty roster would make every
    // completeness assertion below vacuous.
    const names = enumerated.map((t) => t.modelName);
    expect(names.length).toBeGreaterThan(25);
    for (const known of ["user", "session", "account", "organization", "member", "scimUser", "scimManagedConnection"]) {
      expect(names, `expected Better Auth table ${known} in the enumeration`).toContain(known);
    }
  });

  it("every enumerated Better Auth table has a purge decision AND a bundle decision", () => {
    // THE #5515 guard: the class the Drizzle tripwires cannot see. A table
    // here with no entry is exactly how the scim* catalog survived a GDPR
    // purge invisibly.
    const missing = enumerated
      .map((t) => t.modelName)
      .filter((name) => purgeDecisionFor[name] === undefined || bundleDecisionFor[name] === undefined);
    expect(
      missing,
      `Better Auth table(s) with no decision: ${missing.join(", ")}.\n` +
        `Add each to BETTER_AUTH_PURGE_DECISIONS (lib/db/purge-scope.ts) AND ` +
        `BETTER_AUTH_BUNDLE_DECISIONS (lib/residency/bundle-scope.ts). These tables are NOT in ` +
        `db/schema.ts, so no schema enumeration will ever force this — this test is the only ` +
        `guard, which is why it fails hard rather than warning.`,
    ).toEqual([]);
  });

  it("has no stale registry entries for tables the plugin roster no longer declares", () => {
    const names = new Set(enumerated.map((t) => t.modelName));
    const stale = [
      ...Object.keys(BETTER_AUTH_PURGE_DECISIONS),
      ...Object.keys(BETTER_AUTH_BUNDLE_DECISIONS),
    ].filter((name) => !names.has(name));
    expect(
      [...new Set(stale)],
      `Registry entries for Better Auth tables the roster no longer declares: ${stale.join(", ")}.`,
    ).toEqual([]);
  });

  it("keeps the two Better Auth registries over the same key set", () => {
    // A table decided for the purge but not for residency (or vice versa) is
    // half the blind spot back.
    expect(Object.keys(BETTER_AUTH_PURGE_DECISIONS).toSorted()).toEqual(
      Object.keys(BETTER_AUTH_BUNDLE_DECISIONS).toSorted(),
    );
  });

  it("keeps subscription in the Drizzle registries, not here (the pinned Stripe exemption)", () => {
    // The stripe plugin cannot boot in this roster (secrets + internal DB), so
    // its table cannot be enumerated here. The exemption is safe only while
    // `subscription` stays mirrored in db/schema.ts and covered by the Drizzle
    // registries — asserted, so the exemption cannot rot into a hole.
    for (const table of STRIPE_GATED_TABLES) {
      expect(purgeDecisionFor[table], `${table} must NOT be double-decided here`).toBeUndefined();
      expect(bundleDecisionFor[table], `${table} must NOT be double-decided here`).toBeUndefined();
      expect(
        table in PURGE_TABLE_DECISIONS,
        `${table} lost its db/schema.ts-registry purge decision — the Stripe exemption is now a hole`,
      ).toBe(true);
      expect(
        table in BUNDLE_TABLE_DECISIONS,
        `${table} lost its db/schema.ts-registry bundle decision — the Stripe exemption is now a hole`,
      ).toBe(true);
    }
  });

  it("every decision carries a non-empty rationale, on both axes", () => {
    for (const [name, entry] of Object.entries(BETTER_AUTH_PURGE_DECISIONS)) {
      expect(entry.reason.trim().length, `${name} has an empty purge reason`).toBeGreaterThan(0);
    }
    for (const [name, entry] of Object.entries(BETTER_AUTH_BUNDLE_DECISIONS)) {
      expect(entry.reason.trim().length, `${name} has an empty bundle reason`).toBeGreaterThan(0);
    }
  });

  it("every 'purged' table has a real DELETE in hardDeleteWorkspace", () => {
    const claimed = [...BETTER_AUTH_PURGED_TABLES].filter((t) => deleteIndexOf(t) === -1);
    expect(
      claimed,
      `Better Auth table(s) marked 'purged' with no DELETE FROM in hardDeleteWorkspace: ` +
        `${claimed.join(", ")}. Either add the DELETE (and its HardDeleteCounts field) or ` +
        `change the decision.`,
    ).toEqual([]);
  });

  it("every explicit-delete 'user_scoped' table has a real orphan-arm DELETE", () => {
    const claimed = [...BETTER_AUTH_ORPHAN_DELETE_TABLES].filter((t) => deleteIndexOf(t) === -1);
    expect(
      claimed,
      `Better Auth table(s) whose orphanArm claims an explicit delete that does not exist: ` +
        `${claimed.join(", ")}.`,
    ).toEqual([]);
  });

  it("every cascade-claimed 'user_scoped' table really declares a user reference", () => {
    // The cascade mechanism is only real if the plugin schema declares the FK
    // the migrator builds it from. Checked against the LIVE field metadata, so
    // an upstream bump that drops a reference (turning "cascade removes it"
    // into "nothing removes it") fails here by name.
    const wrong: string[] = [];
    for (const [name, entry] of Object.entries(BETTER_AUTH_PURGE_DECISIONS)) {
      if (entry.decision !== "user_scoped" || entry.orphanArm !== "user-fk-cascade") continue;
      const table = enumerated.find((t) => t.modelName === name);
      const hasUserRef = Object.values(table?.fields ?? {}).some(
        (f) => f.references?.model === "user" && f.references.field === "id",
      );
      if (!hasUserRef) wrong.push(name);
    }
    expect(
      wrong,
      `Table(s) claiming removal by user-FK cascade with NO declared user reference: ` +
        `${wrong.join(", ")}. The migrator cannot build a cascade from a reference that is not ` +
        `declared, so nothing removes these rows — the decision is wrong, not the schema.`,
    ).toEqual([]);
  });

  it("pins the 'unreached' set exactly (a recorded gap can only grow deliberately)", () => {
    // `unreached` exists so closing the enumeration blind spot is not blocked
    // on fixing every gap it reveals — but it is also the cheapest arm, so its
    // membership is pinned the way RETAINED_TABLES is. EMPTY since #5525 closed
    // `apikey`, the set's only member: no FK at all in the 1.7 schema, owner in
    // `referenceId`, workspace in `metadata.orgId`, and now two statements.
    // Read through the string-indexed view: against the literal-typed const,
    // tsc now rejects the comparison as no-overlap — which is TRUE today and is
    // exactly the state this test exists to keep deliberate, so it must not be
    // what stops the file compiling.
    const unreached = Object.keys(BETTER_AUTH_PURGE_DECISIONS).filter(
      (k) => purgeDecisionFor[k]?.decision === "unreached",
    );
    expect(unreached.toSorted()).toEqual([]);
  });

  it("gives every dual-arm table BOTH a workspace statement and an orphan statement", () => {
    // #5525. `BETTER_AUTH_PURGED_TABLES` and `BETTER_AUTH_ORPHAN_DELETE_TABLES`
    // both contain `apikey`, and the two tests above ask each only for "a
    // DELETE FROM apikey exists" — which ONE statement satisfies twice over.
    // Deleting either arm therefore passes both. This is the assertion that
    // fails: the orphan arm is identifiable by its `referenceId` predicate, so
    // a second, differently-keyed statement must exist alongside it.
    //
    // What this cannot see is whether the OTHER statement is correctly scoped
    // to the workspace — `apikey`'s workspace predicate is evaluated in
    // TypeScript (see hardDeleteWorkspace's Phase 4a), so the SQL reads
    // `id = ANY($1)` and carries no readable scope. That half is proven
    // behaviorally, against a real Postgres, in apikey-purge-pg.test.ts.
    for (const table of BETTER_AUTH_DUAL_ARM_TABLES) {
      const statements = purgeFnBody.match(new RegExp(`DELETE FROM "?${table}"?\\b[^\`]*`, "g")) ?? [];
      const orphanArm = statements.filter((s) => s.includes(`"referenceId" = ANY(`));
      expect(
        statements.length,
        `${table} declares both a workspace decision and an orphanArm, so hardDeleteWorkspace ` +
          `must carry TWO DELETE statements for it — found ${statements.length}.`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        orphanArm.length,
        `${table} declares orphanArm: "explicit-delete" but no DELETE keyed on "referenceId" = ANY(...) ` +
          `exists — an orphaned user's keys would outlive their own account.`,
      ).toBe(1);
      expect(
        statements.length - orphanArm.length,
        `${table} has no DELETE other than its orphan arm — the workspace-scoped statement is gone, ` +
          `so a key bound to the purged workspace whose owner survives elsewhere would remain.`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("probes exactly the scim tables the plugin declares (the probe list cannot drift)", () => {
    // `hardDeleteWorkspace` probes SCIM_PLUGIN_TABLES in one round trip and
    // gates every scim DELETE on the result. That list derives from the
    // registry; this pins it against the plugin's own schema, so an upstream
    // bump that ADDS a scim table fails here (and the completeness test above)
    // rather than shipping a table the probe never looks at.
    const liveScim = enumerated
      .map((t) => t.modelName)
      .filter((n) => n.startsWith("scim"))
      .toSorted();
    // Widened to string so the comparison is name-vs-name; the literal-union
    // typing is the registry's concern, not this assertion's.
    expect(SCIM_PLUGIN_TABLES.map((t): string => t).toSorted()).toEqual(liveScim);
    // And the probe is real: the function consults the derived list.
    expect(
      purgeFnBody.includes("SCIM_PLUGIN_TABLES"),
      "hardDeleteWorkspace no longer reads SCIM_PLUGIN_TABLES — the probe/registry coupling is broken",
    ).toBe(true);
  });

  it("keeps scim-purge-pg's sweep arms covering every DECLARED scim reference", () => {
    // The -pg sweep hunts residue by column name. Its arm list is
    // hand-written there (it has no plugin access), so this is the coupling
    // pin: every field a scim table DECLARES as a reference — to another scim
    // model or to user — must be a column the sweep knows how to chase. An
    // upstream bump that adds a declared reference fails here by name, which
    // is the prompt to add its arm. What this cannot see is a PLAIN-STRING
    // reference (`scimSubject.profileSourceId` holds a scimUser id with no
    // declared FK — found by the #5515 spec review); those are hand-added to
    // the sweep and the purge, and there is no derivable source to pin them
    // against.
    const SWEEP_ARM_COLUMNS = new Set([
      "connectionRecordId",
      "groupId",
      "scimUserId",
      "userId",
      "profileSourceId",
    ]);
    const unswept: string[] = [];
    for (const table of enumerated) {
      if (!table.modelName.startsWith("scim")) continue;
      for (const [field, def] of Object.entries(table.fields)) {
        if (!def.references) continue;
        if (!SWEEP_ARM_COLUMNS.has(field)) {
          unswept.push(`${table.modelName}.${field} -> ${def.references.model}`);
        }
      }
    }
    expect(
      unswept,
      `scim reference column(s) the residue sweep has no arm for: ${unswept.join(", ")}. ` +
        `Add each to the arm map in scim-purge-pg.test.ts (and, if the purge must chase it, ` +
        `to hardDeleteWorkspace's Phase 3f) before widening this list.`,
    ).toEqual([]);
  });

  it("deletes scim children before the parents their subqueries read", () => {
    // Same #5160 ordering rule as the Drizzle registry's viaParent pairs: the
    // child's only scope is a subquery through the parent, so parent-first
    // silently leaves the child behind. scimGroupMember reads BOTH parents.
    const childBeforeParent: Array<[string, string]> = [
      ["scimGroupMember", "scimGroup"],
      ["scimGroupMember", "scimUser"],
      ["scimProjectionGrant", "scimUser"],
      ["scimManagedCredential", "scimManagedConnection"],
      ["scimManagedConnectionEvent", "scimManagedConnection"],
    ];
    for (const [child, parent] of childBeforeParent) {
      const childIdx = deleteIndexOf(child);
      const parentIdx = deleteIndexOf(parent);
      expect(childIdx, `no DELETE for ${child}`).toBeGreaterThan(-1);
      expect(parentIdx, `no DELETE for ${parent}`).toBeGreaterThan(-1);
      expect(
        childIdx,
        `${child} scopes through ${parent} via a subquery, so it must be deleted FIRST — ` +
          `otherwise the subquery finds no parent rows and ${child} is silently left behind.`,
      ).toBeLessThan(parentIdx);
    }
  });

  it("exports nothing from the Better Auth class in the bundle registry", () => {
    // `export.ts` has no Better Auth sections, so an `exported` decision here
    // would be a claim the implementation does not honour — the direction the
    // bundle tripwire calls "the registry outrunning the implementation".
    // Iterated through the string-indexed view: against the literal-typed
    // const, tsc rejects the comparison as no-overlap — which is true today
    // and is exactly the drift this test exists to catch tomorrow.
    const exported = Object.keys(BETTER_AUTH_BUNDLE_DECISIONS).filter(
      (k) => bundleDecisionFor[k]?.decision === "exported",
    );
    expect(
      exported,
      `Better Auth table(s) marked 'exported' with no export.ts section: ${exported.join(", ")}.`,
    ).toEqual([]);
  });

  it("classifies every scim* table 'stays' on the bundle axis", () => {
    // The sso_providers / scim_group_mappings precedent: directory-sync state
    // follows the IdP connection, which is re-created in the target region.
    // scimSubject is the one exception (user-keyed, follows the global spine).
    for (const table of SCIM_PLUGIN_TABLES) {
      const expected = table === "scimSubject" ? "platform" : "stays";
      expect(bundleDecisionFor[table]?.decision, `${table} bundle decision`).toBe(expected);
    }
  });
});
