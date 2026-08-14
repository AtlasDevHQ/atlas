/**
 * The writer set for `brain_enrollment` (#5196, ADR-0039).
 *
 * ## WHY THIS FILE EXISTS
 *
 * ADR-0039's acceptance criterion is *"no self-widening path exists"* — there
 * must be **no code path that enrolls without a person choosing the members**.
 * That is a claim about the whole tree, not about any one function, and no type
 * can carry it: `enrollPair` takes an `actor: string`, and a scheduled fiber can
 * pass `"system"` and satisfy every signature in the codebase.
 *
 * So the claim is asserted as what it is — an enumeration of the files that
 * write this table, checked against the tree.
 *
 * ## The ADR's own prediction is the thing this catches
 *
 * *"Someone will propose a sweep mode. It will arrive as a convenience ('just
 * enroll everything'), as a migration aid ('bulk-enroll on connect'), or as a
 * default ('enroll every dimension the profiler found'). Each is this ADR's
 * rejected alternative with the human step moved somewhere it stops being one."*
 *
 * Every one of those arrives as a new file writing this table. A new writer is
 * not automatically a bug — a bulk affordance over a set an admin TICKED is
 * enrollment, and would legitimately live in the route file already listed — but
 * it is the event that must be argued rather than merged, and nobody would
 * otherwise notice the premise had changed.
 *
 * ## Both directions, because they fail differently
 *
 * - **INSERT** is WIDENING: a machine that enrolls has decided what the Atlas
 *   may hold claims about. That is the authority arm firing automatically,
 *   which ADR-0040 forbids for every source class.
 * - **DELETE** is NARROWING, which fails quietly instead of loudly: a machine
 *   that un-enrolls leaves a producer reaching nothing, and an unenrolled
 *   workspace is indistinguishable from a working one from inside the code
 *   (ADR-0039's Consequences). Its allowlist is different — the workspace hard
 *   delete legitimately removes these rows — so it is checked separately rather
 *   than folded in.
 *
 * This is a source-text test and it says so: it proves what the tree CONTAINS,
 * never what runs. `enrollment-pg.test.ts` owns whether the reach behaves.
 */

import { describe, expect, test } from "bun:test";
import * as enrollmentSeam from "@atlas/api/lib/brain/enrollment";
import { BRAIN_ENROLLMENT_NAME_MAX } from "@useatlas/schemas";

// `src/`, from `src/lib/brain/__tests__/`. Resolved off `import.meta.url` and
// not `process.cwd()`: the isolated runner and a bare `bun test` disagree about
// the working directory, and a cwd-relative root would silently scan nothing
// under one of them.
const SRC_ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * The only two files that may INSERT.
 *
 * Both are human-initiated end to end. There is deliberately no fiber, no
 * connector, and no profiler entry — see the header.
 */
const KNOWN_INSERT_WRITERS: readonly string[] = [
  // The storage seam. Its `enrollPair` is reachable only from the admin route
  // below, which re-resolves the principal against this workspace and refuses
  // any origin that does not clear the owner/admin bar.
  "lib/brain/enrollment.ts",
  // The region importer (ADR-0024). Not a new decision: every row it lands was
  // enrolled by a person in the source region, and the merge is a union that
  // never overwrites the destination's own author.
  "api/routes/admin-migrate.ts",
];

/**
 * The only two files that may DELETE.
 *
 * `lib/residency/cleanup.ts` and `lib/db/residue-sweep.ts` also delete these
 * rows, and are deliberately NOT here: both build their statement from a table
 * registry at runtime, so neither contains the literal this scan looks for.
 * That is a real blind spot rather than an oversight, and it is the acceptable
 * one — a registry-driven sweep deletes a departed workspace's rows wholesale
 * and cannot single out an enrollment.
 *
 * ⚠️ **The second blind spot is `ee/`.** `SRC_ROOT` is `packages/api/src`, so a
 * writer landing in `@atlas/ee` — where the residency and proactive seams
 * already live — would not be seen. Named here rather than left implicit,
 * because the header above claims this is a fact about the tree and a reader
 * checking that claim deserves its edges. `fact-writers.test.ts` has the same
 * root and the same gap; widening both is one change and belongs in whichever
 * PR first puts brain code in `ee/`.
 */
const KNOWN_DELETE_WRITERS: readonly string[] = [
  // The storage seam's `unenrollPair` — the admin's own act.
  "lib/brain/enrollment.ts",
  // The workspace hard delete (#5160). Removes the workspace, enrollments
  // included.
  "lib/db/internal.ts",
];

/** `INSERT INTO [schema.]["]brain_enrollment["]`, plus the Drizzle builder half. */
const INSERTS_ENROLLMENT =
  /(insert\s+into\s+(?:[a-z_][\w$]*\s*\.\s*)?"?brain_enrollment"?)|(\.insert\(\s*(?:schema\s*\.\s*)?brainEnrollment\s*\))/i;

/** The same shape for the narrowing verb. */
const DELETES_ENROLLMENT =
  /(delete\s+from\s+(?:[a-z_][\w$]*\s*\.\s*)?"?brain_enrollment"?)|(\.delete\(\s*(?:schema\s*\.\s*)?brainEnrollment\s*\))/i;

async function scanFor(pattern: RegExp): Promise<{ found: string[]; scanned: number }> {
  const { Glob } = await import("bun");
  const found: string[] = [];
  let scanned = 0;
  for await (const file of new Glob("**/*.ts").scan({ cwd: SRC_ROOT, absolute: true })) {
    // Tests seed fixtures freely; migrations are DDL, not a runtime writer.
    if (file.includes("__tests__") || file.includes("/migrations/")) continue;
    scanned++;
    const source = await Bun.file(file).text();
    if (pattern.test(source)) found.push(file.slice(SRC_ROOT.length));
  }
  return { found: found.sort(), scanned };
}

describe("brain_enrollment writer set (#5196, ADR-0039)", () => {
  test("exactly the two known writers INSERT into brain_enrollment", async () => {
    const { found, scanned } = await scanFor(INSERTS_ENROLLMENT);

    // A moved or renamed directory would otherwise make every assertion below
    // pass having read nothing at all.
    expect(scanned, `no sources scanned under ${SRC_ROOT} — has the tree moved?`).toBeGreaterThan(
      100,
    );

    expect(
      found,
      "the set of brain_enrollment INSERT sites changed. ADR-0039 forbids any code path that " +
        "enrolls without a person choosing the members — a writer that runs on connect, on " +
        "profile, or on a schedule is the sweep this whole surface exists instead of. If the new " +
        "writer really is a person's deliberate act over a set they can see, say so here and in " +
        "the ADR; do not just extend the list",
    ).toEqual([...KNOWN_INSERT_WRITERS].sort());
  });

  test("exactly the two known writers DELETE from brain_enrollment", async () => {
    const { found, scanned } = await scanFor(DELETES_ENROLLMENT);
    expect(scanned).toBeGreaterThan(100);
    expect(
      found,
      "the set of brain_enrollment DELETE sites changed. A machine that un-enrolls leaves the " +
        "producer reaching nothing, and an unenrolled workspace is indistinguishable from a " +
        "working one from inside the code",
    ).toEqual([...KNOWN_DELETE_WRITERS].sort());
  });

  test("the region import enforces the same pair rules as the seam", async () => {
    // `normalizeEnrollmentPair`'s docstring says the region import does NOT come
    // through it and carries the rules itself. That is a claim about another
    // file, so it is checked rather than asserted: an importer that dropped the
    // trim would land `"  accounts"` past `ck_brain_enrollment_names_present`
    // (which is `entity <> ''` and admits whitespace), and the pair would sit in
    // the destination's list looking live while the producer never matches it.
    const source = await Bun.file(`${SRC_ROOT}api/routes/admin-migrate.ts`).text();
    const arm = source.slice(source.indexOf('"brainEnrollments" in obj'));
    expect(arm.length, "the brainEnrollments validation arm is gone").toBeGreaterThan(0);
    const enrollmentArm = arm.slice(0, arm.indexOf("return { ok: true"));
    expect(enrollmentArm).toContain("value.trim()");
    expect(enrollmentArm).toContain("BRAIN_ENROLLMENT_NAME_MAX");
    // And the seam's own bound is the SAME constant, not a second literal.
    expect(enrollmentSeam.ENROLLMENT_NAME_MAX).toBe(BRAIN_ENROLLMENT_NAME_MAX);
  });

  test("the patterns actually match the statements they claim to — the tripwire's own falsifier", () => {
    // ⚠️ Both scans above are satisfied by a pattern that matches NOTHING, as
    // long as the allowlists were emptied to match. These are the arms that
    // make a real writer detectable, checked against literals rather than
    // against the tree so they stay true when the tree changes.
    expect(INSERTS_ENROLLMENT.test("INSERT INTO brain_enrollment (workspace_id)")).toBe(true);
    expect(INSERTS_ENROLLMENT.test("insert into public.brain_enrollment")).toBe(true);
    expect(INSERTS_ENROLLMENT.test("db.insert(brainEnrollment)")).toBe(true);
    expect(DELETES_ENROLLMENT.test("DELETE FROM brain_enrollment WHERE workspace_id = $1")).toBe(
      true,
    );
    // And do not match the neighbouring table, whose name this one is a prefix
    // of nothing but which shares the `brain_` stem every table here has.
    expect(INSERTS_ENROLLMENT.test("INSERT INTO brain_episodes")).toBe(false);
    expect(DELETES_ENROLLMENT.test("DELETE FROM brain_facts")).toBe(false);
    // A SELECT is not a write. Without this the INSERT pattern could be
    // loosened to `brain_enrollment` alone and still pass every arm above,
    // while flagging the producer's read as a writer.
    expect(INSERTS_ENROLLMENT.test("SELECT entity FROM brain_enrollment")).toBe(false);
    expect(DELETES_ENROLLMENT.test("SELECT entity FROM brain_enrollment")).toBe(false);
  });

  test("the storage seam exports no bulk or automatic enrollment verb", () => {
    // The second half, and the one the file scan structurally cannot see: a
    // sweep does not need a new FILE. `enrollAllDimensions` added to
    // `enrollment.ts` writes from an already-allowlisted file and passes every
    // arm above.
    //
    // Named exports rather than a substring search, so the prose in that
    // module's header — which discusses exactly these names in order to explain
    // why they are absent — cannot satisfy or trip the check.
    expect(Object.keys(enrollmentSeam).toSorted()).toEqual([
      "ENROLLMENT_NAME_MAX",
      "InvalidEnrollmentPairError",
      "UnattributedEnrollmentError",
      "enrollPair",
      "listEnrollments",
      "loadProducerReach",
      // A PURE DERIVATION, not a writer: it takes pairs the caller already holds
      // and returns a value. It exists so a reach can be built without a
      // database — the alternative was every consumer hand-building the three
      // fields, which is how an inconsistent one gets made.
      "makeProducerReach",
      "normalizeEnrollmentPair",
      "unenrollPair",
    ]);
  });
});
