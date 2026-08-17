/**
 * The Live boot-seed Layers of `effect/layers.ts` (#5273).
 *
 * `BuiltinDatasourceCatalogSeedLive`, `BuiltinKnowledgeCatalogSeedLive` — the two
 * #5273 names — plus `OpenApiDatasourceCatalogSeedLive`, which this PR's review
 * panel added after finding it had the very defect the other two were being pinned
 * against (see that describe block), and a lexical guard that makes a fourth
 * instance a test failure rather than a reviewer's lucky read.
 *
 * The first harness in the repo to drive a boot-seed Layer's DYNAMIC IMPORT — which
 * is items (2) and (3) below, not (1). `layers.test.ts` already builds Live boot
 * Layers behind a stubbed `InternalDB` + `Migration` (`runOverride`,
 * `makeConnectionsHydrateLive`), so that part is precedented. What it does with these
 * three Tags is supply exactly one of them, `BuiltinDatasourceCatalogSeed`, as a
 * `Layer.succeed(...)` stub — which exercises the wiring around it and nothing inside
 * it. The knowledge and OpenAPI Tags appear there not at all. The consequence was
 * measured: the `case "seeded"` arm is the ONLY route by which `blockedSlugs` (the
 * field #5266/#5239 exist to produce) reaches the Tag at all — nothing serves the
 * shape over HTTP today, as the field's own docstring says, so the Layer's value is
 * the only place a consumer could ever read it. Replacing the three forwarded fields
 * with `...zeroCounts` was green across the whole suite.
 *
 * ## Why this needs a new pattern
 *
 * Each Layer resolves its boot wrapper through a dynamic `await import(...)` inside
 * `Effect.tryPromise`, and each gates on `InternalDB` + `Migration` upstream. So a
 * test needs three things at once:
 *
 *   1. `InternalDB` and `Migration` stubbed as Layers — `db.available` and
 *      `migration.migrated` drive the `skipped-gate` arm before any import
 *      happens.
 *   2. The dynamic import intercepted, so the three boot-result kinds — plus a
 *      rejection, which is the `catchAll` seam and not a kind — can be driven
 *      directly instead of through a real Postgres.
 *   3. The interception to leave the rest of the seed module intact — `mock.module`
 *      replaces the WHOLE module and the catalog row tables ship from the same
 *      file, so any export left out becomes `undefined` for every consumer in this
 *      process, the Live Layer included.
 *
 * (3) is why each `mock.module` factory spreads a SNAPSHOT of the real module
 * rather than listing exports by hand: `import * as` evaluates before the
 * `mock.module` call (import declarations are hoisted), so `{ ...realModule }`
 * captures the genuine values and the mock overrides exactly one function. A
 * hand-written export list would silently drop the next `BUILTIN_*_CATALOG_ROW`
 * someone adds.
 *
 * The override is `() => datasourceBoot()`, not `datasourceBoot` — one level of
 * indirection so a test can swap the implementation after the factory has
 * already run and been cached.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import * as realDatasourceSeedModule from "@atlas/api/lib/db/seed-builtin-datasource-catalog";
import * as realKnowledgeSeedModule from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";
import * as realOpenApiSeedModule from "@atlas/api/lib/openapi/catalog-seed";
import type { BuiltinDatasourceCatalogSeedBootResult } from "@atlas/api/lib/db/seed-builtin-datasource-catalog";
import type { BuiltinKnowledgeCatalogSeedBootResult } from "@atlas/api/lib/db/seed-builtin-knowledge-catalog";
import type { OpenApiDatasourceCatalogSeedBootResult } from "@atlas/api/lib/openapi/catalog-seed";
import { createInternalDBTestLayer } from "@atlas/api/lib/db/internal";
import {
  BuiltinDatasourceCatalogSeed,
  BuiltinDatasourceCatalogSeedLive,
  BuiltinKnowledgeCatalogSeed,
  BuiltinKnowledgeCatalogSeedLive,
  OpenApiDatasourceCatalogSeed,
  OpenApiDatasourceCatalogSeedLive,
  Migration,
  type BuiltinDatasourceCatalogSeedShape,
  type BuiltinKnowledgeCatalogSeedShape,
  type OpenApiDatasourceCatalogSeedShape,
} from "../layers";

// ── The dynamic-import interception ─────────────────────────────────

/** Snapshots taken before `mock.module` replaces any of the three modules. */
const realDatasourceExports = { ...realDatasourceSeedModule };
const realKnowledgeExports = { ...realKnowledgeSeedModule };
const realOpenApiExports = { ...realOpenApiSeedModule };

const NOT_CONFIGURED =
  "boot stub not configured by this test — the Layer reached the dynamic import unexpectedly";

let datasourceBoot: () => Promise<BuiltinDatasourceCatalogSeedBootResult> = () =>
  Promise.reject(new Error(NOT_CONFIGURED));
let knowledgeBoot: () => Promise<BuiltinKnowledgeCatalogSeedBootResult> = () =>
  Promise.reject(new Error(NOT_CONFIGURED));
let openApiBoot: () => Promise<OpenApiDatasourceCatalogSeedBootResult> = () =>
  Promise.reject(new Error(NOT_CONFIGURED));

const datasourceBootCalls = mock(() => {});
const knowledgeBootCalls = mock(() => {});
const openApiBootCalls = mock(() => {});

void mock.module("@atlas/api/lib/db/seed-builtin-datasource-catalog", () => ({
  ...realDatasourceExports,
  runBuiltinDatasourceCatalogSeedBoot: () => {
    datasourceBootCalls();
    return datasourceBoot();
  },
}));

void mock.module("@atlas/api/lib/db/seed-builtin-knowledge-catalog", () => ({
  ...realKnowledgeExports,
  runBuiltinKnowledgeCatalogSeedBoot: () => {
    knowledgeBootCalls();
    return knowledgeBoot();
  },
}));

void mock.module("@atlas/api/lib/openapi/catalog-seed", () => ({
  ...realOpenApiExports,
  runOpenApiDatasourceCatalogSeedBoot: () => {
    openApiBootCalls();
    return openApiBoot();
  },
}));

afterEach(() => {
  datasourceBootCalls.mockClear();
  knowledgeBootCalls.mockClear();
  openApiBootCalls.mockClear();
  datasourceBoot = () => Promise.reject(new Error(NOT_CONFIGURED));
  knowledgeBoot = () => Promise.reject(new Error(NOT_CONFIGURED));
  openApiBoot = () => Promise.reject(new Error(NOT_CONFIGURED));
});

// ── Layer drivers ───────────────────────────────────────────────────

interface UpstreamGate {
  readonly available?: boolean;
  readonly migrated?: boolean;
}

// `InternalDB` + `Migration` are rebuilt per call rather than shared. The reason
// is legibility, NOT necessity — and the first version of this comment claimed
// necessity, which is measurably false: hoisting the composed seed layer to module
// scope and sharing it across every call leaves the suite at 29/29, because each
// `Effect.provide`/`runPromise` builds its own MemoMap and the `Layer.effect`
// therefore re-runs anyway.
//
// Per-call construction is kept because it makes each case's independence a
// property of the code rather than of Effect's memo scoping — a reader should not
// have to know where the MemoMap boundary is to know that the stub set two lines
// up is the stub that runs.

function runDatasourceSeed(
  gate: UpstreamGate = {},
): Promise<BuiltinDatasourceCatalogSeedShape> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* BuiltinDatasourceCatalogSeed;
    }).pipe(
      Effect.provide(
        BuiltinDatasourceCatalogSeedLive.pipe(
          Layer.provide(
            Layer.merge(
              createInternalDBTestLayer({ available: gate.available ?? true }),
              Layer.succeed(Migration, { migrated: gate.migrated ?? true }),
            ),
          ),
        ),
      ),
    ),
  );
}

function runKnowledgeSeed(
  gate: UpstreamGate = {},
): Promise<BuiltinKnowledgeCatalogSeedShape> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* BuiltinKnowledgeCatalogSeed;
    }).pipe(
      Effect.provide(
        BuiltinKnowledgeCatalogSeedLive.pipe(
          Layer.provide(
            Layer.merge(
              createInternalDBTestLayer({ available: gate.available ?? true }),
              Layer.succeed(Migration, { migrated: gate.migrated ?? true }),
            ),
          ),
        ),
      ),
    ),
  );
}

function runOpenApiSeed(
  gate: UpstreamGate = {},
): Promise<OpenApiDatasourceCatalogSeedShape> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* OpenApiDatasourceCatalogSeed;
    }).pipe(
      Effect.provide(
        OpenApiDatasourceCatalogSeedLive.pipe(
          Layer.provide(
            Layer.merge(
              createInternalDBTestLayer({ available: gate.available ?? true }),
              Layer.succeed(Migration, { migrated: gate.migrated ?? true }),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * A pg connect failure whose message carries the DB password, which is the
 * hazard `errorMessage` exists for. The password is a distinct token so a test
 * can assert its ABSENCE rather than only asserting the scrubbed shape's
 * presence.
 */
const CREDENTIAL_LEAK_MESSAGE =
  "connect ECONNREFUSED postgres://seeduser:hunter2@db.internal:5432/atlas";
const CREDENTIAL_SCRUBBED =
  "connect ECONNREFUSED postgres://***@db.internal:5432/atlas";

// ══════════════════════════════════════════════════════════════════════
// BuiltinDatasourceCatalogSeedLive
// ══════════════════════════════════════════════════════════════════════

describe("BuiltinDatasourceCatalogSeedLive", () => {
  // ── the `skipped-gate` arm, both halves of its `||` ────────────────
  //
  // The guard is `!db.available || !migration.migrated`. Each disjunct gets its
  // own case: an `&&` typo, or a guard that reads only one Tag, produces the
  // right answer for the both-false input and the wrong one for exactly one of
  // the singles. A both-false-only test cannot see that.

  test("skips on `!db.available` alone, without reaching the import", async () => {
    const shape = await runDatasourceSeed({ available: false, migrated: true });
    expect(shape.outcome).toBe("skipped-gate");
    expect(datasourceBootCalls).not.toHaveBeenCalled();
  });

  test("skips on `!migration.migrated` alone, without reaching the import", async () => {
    const shape = await runDatasourceSeed({ available: true, migrated: false });
    expect(shape.outcome).toBe("skipped-gate");
    expect(datasourceBootCalls).not.toHaveBeenCalled();
  });

  test("skips when both upstream halves are unsatisfied", async () => {
    const shape = await runDatasourceSeed({ available: false, migrated: false });
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.insertedSlugs).toEqual([]);
    expect(shape.preservedSlugs).toEqual([]);
    expect(shape.blockedSlugs).toEqual([]);
    expect(shape.error).toBeUndefined();
    expect(datasourceBootCalls).not.toHaveBeenCalled();
  });

  test("a boot-wrapper `kind: 'skipped'` also lands on `skipped-gate` — but DID run", async () => {
    // Same `outcome` as the upstream gate above, reached down a different path.
    // The call count is the only thing that tells the two apart, which is why
    // the gate cases assert `not.toHaveBeenCalled()`.
    datasourceBoot = () =>
      Promise.resolve({ kind: "skipped", reason: "no-internal-db" });
    const shape = await runDatasourceSeed();
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.blockedSlugs).toEqual([]);
    expect(datasourceBootCalls).toHaveBeenCalledTimes(1);
  });

  // ── the `seeded` arm — the mutation this issue exists for ──────────

  test("⭐ forwards inserted / preserved / blocked slugs at THREE distinct lengths", async () => {
    // ⚠️ THE HEADLINE MUTATION (#5273): replace the three forwarded fields in
    // the `case "seeded"` arm with `...zeroCounts`. That was green across the
    // entire suite before this test existed, because no test ever built the
    // Live Layer.
    //
    // Three DIFFERENT lengths — 3 inserted, 2 preserved, 1 blocked — and three
    // DISJOINT slug sets. The disjointness is what defeats a permutation, since the
    // assertions below compare CONTENTS with `toEqual`; the distinct lengths are
    // belt-and-braces, and the first version of this comment credited them with the
    // work the content comparison is actually doing. Kept anyway, because they cost
    // nothing and they are the property a future weaker assertion (a `toHaveLength`
    // added in a hurry) would need. (`seed-builtin-datasource-catalog.test.ts` one
    // Layer down had to settle for content-only assertions because its fixture gave
    // blocked and preserved the same size; here the fixture is synthetic, so the
    // sizes are free.)
    datasourceBoot = () =>
      Promise.resolve({
        kind: "seeded",
        insertedSlugs: ["postgres", "mysql", "bigquery"],
        preservedSlugs: ["snowflake", "duckdb"],
        blockedSlugs: ["clickhouse"],
      });

    const shape = await runDatasourceSeed();

    expect(shape.outcome).toBe("seeded");
    expect(shape.insertedSlugs).toEqual(["postgres", "mysql", "bigquery"]);
    expect(shape.preservedSlugs).toEqual(["snowflake", "duckdb"]);
    expect(shape.blockedSlugs).toEqual(["clickhouse"]);
    expect(shape.error).toBeUndefined();
  });

  test("a seed that blocked EVERY row still reports `seeded` with the blocked list", async () => {
    // The state the shape's doc comment warns about: `outcome: "seeded"` with
    // nothing inserted. A consumer reading `outcome` alone is told the catalog
    // is fine; `blockedSlugs` is the only field that says otherwise, so it has
    // to survive the arm even when the other two are genuinely empty.
    datasourceBoot = () =>
      Promise.resolve({
        kind: "seeded",
        insertedSlugs: [],
        preservedSlugs: [],
        blockedSlugs: ["postgres", "mysql"],
      });

    const shape = await runDatasourceSeed();

    expect(shape.outcome).toBe("seeded");
    expect(shape.blockedSlugs).toEqual(["postgres", "mysql"]);
    expect(shape.insertedSlugs).toEqual([]);
    expect(shape.preservedSlugs).toEqual([]);
  });

  // ── the `error` arm ───────────────────────────────────────────────

  test("⭐ SCRUBS the boot wrapper's error message", async () => {
    // `error` is DOCUMENTED as scrubbed. #5239 fixed the asymmetry one Layer
    // over (one arm raw, its sibling scrubbed) and nothing pinned it here or on
    // the knowledge side, so dropping `errorMessage(...)` from either producing
    // arm was a green change that puts the DB password in a health payload.
    datasourceBoot = () =>
      Promise.resolve({ kind: "error", message: CREDENTIAL_LEAK_MESSAGE });

    const shape = await runDatasourceSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe(CREDENTIAL_SCRUBBED);
    expect(shape.error).not.toContain("hunter2");
    // `[]` here means UNKNOWN, not "none" — the arm cannot know what the
    // abandoned pass had accumulated. Pinned so the meaning does not drift.
    expect(shape.insertedSlugs).toEqual([]);
    expect(shape.preservedSlugs).toEqual([]);
    expect(shape.blockedSlugs).toEqual([]);
  });

  // ── the `catchAll` arm ────────────────────────────────────────────

  test("⭐ catchAll SCRUBS a rejection from the dynamic-import seam", async () => {
    // In production this arm is reached when the dynamic `import(...)` itself
    // rejects — the boot wrapper catches its own SQL errors and returns
    // `kind: "error"` instead. The arm cannot distinguish an import rejection
    // from a wrapper rejection: both simply reject the `Effect.tryPromise`
    // `try` promise, and this test drives it with the latter.
    datasourceBoot = () => Promise.reject(new Error(CREDENTIAL_LEAK_MESSAGE));

    const shape = await runDatasourceSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe(CREDENTIAL_SCRUBBED);
    expect(shape.error).not.toContain("hunter2");
    expect(shape.blockedSlugs).toEqual([]);
  });

  test("catchAll normalizes a non-Error rejection", async () => {
    // `catch: (err) => err instanceof Error ? err : new Error(String(err))`.
    // Without the normalizer `errorMessage` still stringifies, so the
    // observable claim is that the value survives rather than becoming
    // `[object Object]` or an empty string.
    datasourceBoot = () => Promise.reject("import map resolution failed");

    const shape = await runDatasourceSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe("import map resolution failed");
  });

  test("never fails the Layer — every arm succeeds", async () => {
    // The Layer's error channel is `never`: a seed failure must degrade the
    // health payload, not take the boot down. `Effect.runPromise` above would
    // reject if any arm escaped, so this asserts it on the harshest input.
    datasourceBoot = () => Promise.reject(new Error("total failure"));
    await expect(runDatasourceSeed()).resolves.toMatchObject({
      outcome: "error",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// BuiltinKnowledgeCatalogSeedLive
// ══════════════════════════════════════════════════════════════════════

describe("BuiltinKnowledgeCatalogSeedLive", () => {
  test("skips on `!db.available` alone, without reaching the import", async () => {
    const shape = await runKnowledgeSeed({ available: false, migrated: true });
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.inserted).toBe(false);
    expect(knowledgeBootCalls).not.toHaveBeenCalled();
  });

  test("skips on `!migration.migrated` alone, without reaching the import", async () => {
    const shape = await runKnowledgeSeed({ available: true, migrated: false });
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.inserted).toBe(false);
    expect(knowledgeBootCalls).not.toHaveBeenCalled();
  });

  test("skips when both upstream halves are unsatisfied", async () => {
    const shape = await runKnowledgeSeed({ available: false, migrated: false });
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.inserted).toBe(false);
    expect(shape.blockedSlugs).toEqual([]);
    expect(shape.error).toBeUndefined();
    expect(knowledgeBootCalls).not.toHaveBeenCalled();
  });

  test("a boot-wrapper `kind: 'skipped'` also lands on `skipped-gate` — but DID run", async () => {
    knowledgeBoot = () =>
      Promise.resolve({ kind: "skipped", reason: "no-internal-db" });
    const shape = await runKnowledgeSeed();
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.inserted).toBe(false);
    expect(knowledgeBootCalls).toHaveBeenCalledTimes(1);
  });

  test("⭐ forwards a NON-EMPTY blockedSlugs alongside `inserted: true`", async () => {
    // The knowledge sibling of the headline mutation: `blockedSlugs: []` or
    // `inserted: false` hardcoded in the `case "seeded"` arm. Two blocked slugs
    // rather than one, and asserted on CONTENTS, so a hardcoded single-element
    // list cannot pass either.
    //
    // `inserted: true` WITH blocked rows is the real combination #5239 named:
    // twelve rows landed, two did not, and the boolean alone reads as success.
    knowledgeBoot = () =>
      Promise.resolve({
        kind: "seeded",
        inserted: true,
        blockedSlugs: ["gitbook", "zendesk"],
      });

    const shape = await runKnowledgeSeed();

    expect(shape.outcome).toBe("seeded");
    expect(shape.inserted).toBe(true);
    expect(shape.blockedSlugs).toEqual(["gitbook", "zendesk"]);
    expect(shape.error).toBeUndefined();
  });

  test("⭐ `inserted: false` with blocked rows is distinct from a clean re-boot", async () => {
    // `inserted: false` has two meanings — "every row already existed" and
    // "nothing could be inserted" — and `blockedSlugs` is the discriminator.
    // Both cases run through the same arm, so both are asserted here: a Layer
    // that forwarded `inserted` but hardcoded `blockedSlugs: []` would pass the
    // second and fail the first.
    knowledgeBoot = () =>
      Promise.resolve({
        kind: "seeded",
        inserted: false,
        blockedSlugs: ["okf-upload"],
      });
    const blocked = await runKnowledgeSeed();
    expect(blocked.outcome).toBe("seeded");
    expect(blocked.inserted).toBe(false);
    expect(blocked.blockedSlugs).toEqual(["okf-upload"]);

    knowledgeBoot = () =>
      Promise.resolve({ kind: "seeded", inserted: false, blockedSlugs: [] });
    const reboot = await runKnowledgeSeed();
    expect(reboot.outcome).toBe("seeded");
    expect(reboot.inserted).toBe(false);
    expect(reboot.blockedSlugs).toEqual([]);
  });

  test("⭐ SCRUBS the boot wrapper's error message", async () => {
    knowledgeBoot = () =>
      Promise.resolve({ kind: "error", message: CREDENTIAL_LEAK_MESSAGE });

    const shape = await runKnowledgeSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe(CREDENTIAL_SCRUBBED);
    expect(shape.error).not.toContain("hunter2");
    expect(shape.inserted).toBe(false);
    expect(shape.blockedSlugs).toEqual([]);
  });

  test("⭐ catchAll SCRUBS a rejection from the dynamic-import seam", async () => {
    knowledgeBoot = () => Promise.reject(new Error(CREDENTIAL_LEAK_MESSAGE));

    const shape = await runKnowledgeSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe(CREDENTIAL_SCRUBBED);
    expect(shape.error).not.toContain("hunter2");
    expect(shape.inserted).toBe(false);
    expect(shape.blockedSlugs).toEqual([]);
  });

  test("catchAll normalizes a non-Error rejection", async () => {
    knowledgeBoot = () => Promise.reject("import map resolution failed");
    const shape = await runKnowledgeSeed();
    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe("import map resolution failed");
  });

  test("never fails the Layer — every arm succeeds", async () => {
    knowledgeBoot = () => Promise.reject(new Error("total failure"));
    await expect(runKnowledgeSeed()).resolves.toMatchObject({
      outcome: "error",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// OpenApiDatasourceCatalogSeedLive — the third sibling, and the one that
// was actually broken
// ══════════════════════════════════════════════════════════════════════

describe("OpenApiDatasourceCatalogSeedLive", () => {
  // This Layer was NOT in #5273's scope. It arrived because the review panel read
  // the enclosing FILE rather than the changed lines, and found `case "error":`
  // filling the shape straight from the wrapper's message while the shape's own doc
  // says "Scrubbed error message" and the `catchAll` arm below scrubbed. That is the
  // #5239 asymmetry — one field, two producers, two guarantees — for the THIRD time.
  //
  // Two consequences, both here: the arm is covered like its siblings, and the
  // lexical guard below makes a fourth instance a test failure rather than a
  // reviewer's lucky read.

  test("skips on `!db.available` alone, without reaching the import", async () => {
    const shape = await runOpenApiSeed({ available: false, migrated: true });
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.inserted).toBe(false);
    expect(openApiBootCalls).not.toHaveBeenCalled();
  });

  test("skips on `!migration.migrated` alone, without reaching the import", async () => {
    const shape = await runOpenApiSeed({ available: true, migrated: false });
    expect(shape.outcome).toBe("skipped-gate");
    expect(openApiBootCalls).not.toHaveBeenCalled();
  });

  test("a boot-wrapper `kind: 'skipped'` also lands on `skipped-gate` — but DID run", async () => {
    openApiBoot = () => Promise.resolve({ kind: "skipped", reason: "no-internal-db" });
    const shape = await runOpenApiSeed();
    expect(shape.outcome).toBe("skipped-gate");
    expect(shape.inserted).toBe(false);
    expect(openApiBootCalls).toHaveBeenCalledTimes(1);
  });

  test("forwards `inserted` on the seeded arm, both ways", async () => {
    // Both values, because `inserted: false` is what a hardcoded forward produces
    // and a happy-path-only test would pin exactly that.
    openApiBoot = () => Promise.resolve({ kind: "seeded", inserted: true });
    expect(await runOpenApiSeed()).toMatchObject({ outcome: "seeded", inserted: true });

    openApiBoot = () => Promise.resolve({ kind: "seeded", inserted: false });
    expect(await runOpenApiSeed()).toMatchObject({ outcome: "seeded", inserted: false });
  });

  test("⭐ SCRUBS the boot wrapper's error message — the arm that was RAW", async () => {
    openApiBoot = () => Promise.resolve({ kind: "error", message: CREDENTIAL_LEAK_MESSAGE });

    const shape = await runOpenApiSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe(CREDENTIAL_SCRUBBED);
    expect(shape.error).not.toContain("hunter2");
    expect(shape.inserted).toBe(false);
  });

  test("⭐ catchAll SCRUBS a rejection from the dynamic-import seam", async () => {
    openApiBoot = () => Promise.reject(new Error(CREDENTIAL_LEAK_MESSAGE));

    const shape = await runOpenApiSeed();

    expect(shape.outcome).toBe("error");
    expect(shape.error).toBe(CREDENTIAL_SCRUBBED);
    expect(shape.error).not.toContain("hunter2");
  });
});

// ══════════════════════════════════════════════════════════════════════
// The lexical guard — three hand-fixes is where prose stops being enough
// ══════════════════════════════════════════════════════════════════════

describe("no seed Layer fills its `error` field from a raw wrapper message", () => {
  /**
   * ⚠️ A LEXICAL GUARD, added because one defect was fixed by hand THREE times:
   * #5239 on the knowledge Layer, #5273 on the knowledge + datasource Layers, and
   * this PR's review on the OpenAPI sibling. Each fix was correct about its
   * instance and blind to the next, which says the instrument is wrong rather than
   * the reviewers.
   *
   * The rule, stated as narrowly as it is true: in `layers.ts`, a shape field
   * documented as a scrubbed error message must not be filled straight from a boot
   * wrapper's `result.message`. Wrap it in `errorMessage` from
   * `lib/audit/error-scrub` — a `pg` connect failure carries
   * `scheme://user:pass@host` in `message`.
   *
   * ⚠️ NARROWED TO THE BOOT-WRAPPER SEAM ON PURPOSE, and the first draft was not.
   * It also matched an `error` field filled from a narrowed local, which fires on
   * `MigrationLive` — whose `MigrationShape.error` is DELIBERATELY raw, because it
   * feeds a boot-failure log line that exists to name the actual Drizzle/pg error
   * (#1988). That is a legitimate producer, and a guard that flags it would be
   * turned off within a week. The negative control below is what caught it; it is
   * not ceremony.
   *
   * The defeated wording lives only in the matcher and is described rather than quoted
   * in the prose above. ⚠️ Note that for THIS guard that is discipline, not necessity:
   * the scan is scoped to `../layers.ts`, so nothing in this file can trip it. The
   * hazard is live for a guard that greps its own tree, and the habit is kept so the
   * next person who widens the scan does not have to rediscover it.
   */
  const FORBIDDEN_RAW_PRODUCERS = [
    // A shape's `error` filled directly from a boot wrapper's message, unscrubbed.
    "error: result.message",
  ];

  const layersSource = (): string =>
    readFileSync(fileURLToPath(new URL("../layers.ts", import.meta.url)), "utf8");

  test("⭐ layers.ts has no `error: result.message` producer", () => {
    const offenders = FORBIDDEN_RAW_PRODUCERS.filter((p) => layersSource().includes(p));
    expect(
      offenders,
      "layers.ts fills a documented-as-scrubbed `error` field straight from a boot " +
        "wrapper's message. Wrap it: `errorMessage(new Error(result.message))`. One field " +
        "with two producers must not have two guarantees (#5239, #5273).",
    ).toEqual([]);
  });

  test("the matcher still matches the shape it was written for", () => {
    // A POSITIVE control on the MATCHER, not on the file. A guard whose pattern has
    // drifted from the shape it was written for reads green over a live instance,
    // which this repo has measured.
    //
    // ⚠️ A PLAIN LITERAL, and the first version assembled it at runtime "so the guard
    // cannot find this string in its own source" — which was a false justification for
    // a real habit. This guard scans `../layers.ts` and nothing else, so it cannot read
    // the file it lives in and a literal here is unreachable by it. The self-trip
    // hazard is real for a guard that greps its own tree (its `WILL DROP` sibling in
    // `admin-migrate-import-errors.test.ts` genuinely hit it), and inheriting the
    // caution was reasonable; writing down a mechanism that does no work was not.
    const planted = "error: result.message,";
    expect(FORBIDDEN_RAW_PRODUCERS.some((p) => planted.includes(p))).toBe(true);
  });

  test("the guard does NOT fire on legitimate code or on prose about it", () => {
    // The NEGATIVE control. Both the matcher and its positive case are written by
    // the same hand, so a matcher broad enough to hit everything passes its own
    // planted case by construction. These four lines are all real: two are
    // legitimate producers in `layers.ts` today, one is `MigrationLive`'s
    // deliberately-raw arm (which the first draft of this matcher flagged), and one
    // is the field docstring that STATES the guarantee.
    const legitimate = [
      "              error: errorMessage(new Error(result.message)),",
      "          error: errorMessage(err),",
      "        return Effect.succeed({ migrated: false, error: err.message } satisfies MigrationShape);",
      "  /** Scrubbed error message when `outcome === \"error\"`. */",
    ];
    for (const line of legitimate) {
      expect(
        FORBIDDEN_RAW_PRODUCERS.some((p) => line.includes(p)),
        `the guard fired on legitimate code or prose: ${line.trim()}`,
      ).toBe(false);
    }
  });
});
