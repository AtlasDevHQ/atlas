/**
 * `brain_coverage_cycle.last_error` may only be written through
 * `storableErrorText` (#5247, residue of #5238).
 *
 * ## What was open
 *
 * `storableErrorText` was `(raw: string) => string`. It applies two rules that
 * come from the store rather than from taste — `ck_brain_coverage_cycle_error_present`
 * refuses `''` (and `new Error().message` IS `''`), and node-pg refuses a NUL
 * parameter outright — so a writer that skips it makes the one statement whose
 * whole job is recording a failure THROW. A visible failure becomes an invisible
 * one through the machinery written to guarantee every red dot carries a message.
 *
 * `coverage-snapshot-pg.test.ts` already pins that BEHAVIOUR for both existing
 * writers, on both adversarial inputs. What nothing pinned was the *routing*:
 * `internalQuery`'s bind array is `unknown[]`, so passing `outcome.error`
 * straight into it compiled, and a THIRD writer with its own SQL was invisible.
 * That is #5032's unbranded-sibling-producer shape, which reopened twice there.
 *
 * ## Two halves, and neither is the other's proof
 *
 * 1. **The brand, checked by the COMPILER.** The `@ts-expect-error` rows below
 *    fail the build if a raw `string` ever becomes assignable to either writer's
 *    `lastError`. They are paired with a positive control, because a parameter
 *    typed `never` would satisfy every negative row while accepting nothing —
 *    the vacuous shape a negative-only suite cannot see.
 * 2. **The writer set, checked by READING the source.** A brand cannot stop a
 *    new function from calling `internalQuery` with its own `last_error` SQL and
 *    never naming the type.
 *
 * ## EXACTLY what the source scan pins, and what it does not
 *
 * An earlier draft of this header claimed the counts were exhaustive — *"there
 * is no way to add a writer that moves neither"*. **Measured false, five ways**,
 * which is why the claim is now itemised instead of asserted. What is pinned:
 *
 * - **raw-SQL `SET last_error = <value>` in `lib/brain/**`** — case-INSENSITIVE
 *   (Postgres is; the first regex was not, so `SET LAST_ERROR = $1` slipped
 *   through) and including quoted literals (the old value class could not match
 *   a quote, so `SET last_error = ''` — the one value the CHECK refuses —
 *   vanished silently);
 * - **every reference to `RECORD_FAILURE_SQL`** beyond its declaration, not just
 *   ones prefixed `internalQuery(`. A `withBrainTransaction((tx) => tx.query(
 *   RECORD_FAILURE_SQL, …))` re-bind adds no new SQL and was invisible to the
 *   anchored pattern, and this file already uses `withBrainTransaction`;
 * - **the Drizzle table symbol `brainCoverageCycle` across the whole API tree**,
 *   which is the shape the raw-SQL scan structurally cannot see:
 *   `db.update(brainCoverageCycle).set({ lastError })` never spells the column
 *   or the table. `schema.ts:brainCoverageCycle` is real and importable;
 * - **the mint's cast count**, so a SECOND `as StorableErrorText` — a sibling
 *   *minter* rather than a sibling writer — cannot appear unnoticed;
 * - **each exported writer's call-site count**, which is what makes the export
 *   safe rather than merely argued-safe. `recordFailureRow` is an UPSERT, so a
 *   new caller does not just write a row, it INVENTS one.
 *
 * What is NOT pinned, stated rather than papered over:
 *
 * - a column name built by interpolation (`SET ${COL} = $1`);
 * - Postgres's multi-column form, `SET (last_attempt_at, last_error) = ($2, $3)`
 *   — a natural refactor of the existing statement;
 * - a comment between the identifier and the `=` (`SET last_error /* x *\/ = $3`);
 * - a plain `INSERT … (…, last_error) VALUES (…)` with NO `ON CONFLICT`. Both
 *   statements that write the column today carry an `ON CONFLICT DO UPDATE SET`,
 *   so the equality sees them; a new INSERT-only writer matches nothing —
 *   measured — and for a `(workspace, class)` pair with no row yet it succeeds,
 *   which is the row-INVENTING hazard this file warns about elsewhere;
 * - a mint that never spells `StorableErrorText`: `as never`,
 *   `as unknown as ReturnType<typeof storableErrorText>`, or
 *   `Parameters<typeof recordFailureRow>[0]["lastError"]` all compile;
 * - any raw-SQL writer outside `lib/brain/**`. Deliberate: `last_error` is also
 *   a column on `crm_outbox`, `lead_outbox`, `email_outbox` and the billing
 *   teardown tables — 16 write sites under `packages/api/src` by this file's own
 *   regex — so a tree-wide scan for it would be dominated by writes this rule
 *   says nothing about. The Drizzle, call-site and type-name scans are what
 *   cover the wide tree, because a symbol is table-specific where a column name
 *   is not.
 *
 * The REMOVAL direction is safe in every case — the equality assertion reds when
 * a known write disappears. It is the ADDITION direction these miss.
 *
 * ## What the scan deliberately permits
 *
 * A `last_error = NULL` write. `RECORD_SUCCESS_SQL` clears the column on a
 * successful cycle, and a NULL needs no sanitizing — the constraint spells this
 * out (`last_error IS NULL OR last_error <> ''`). Classifying it as a violation
 * would make the gate fail on correct code, which is how a gate earns an
 * exemption comment instead of a fix. Reads are permitted for the same reason.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  recordFailureRow,
  storableErrorText,
  updateClassFailureRows,
} from "@atlas/api/lib/brain/coverage-enumeration";

const CYCLE_AT = new Date("2026-08-15T00:00:00.000Z");

// ── 1. the brand ────────────────────────────────────────────────────────────

describe("the last_error writers refuse an unsanitized string at the type level", () => {
  // ⚠️ NEVER CALLED. Every row here is a COMPILE-time assertion; running them
  // would issue real statements against the internal DB. The `expect` at the
  // end of each test is what keeps bun from reporting an assertion-free test —
  // the real verdict is `bun run type` and the `type` CI job.
  test("a raw string is not assignable to recordFailureRow's lastError", () => {
    const unreachable = (): unknown =>
      recordFailureRow({
        workspaceId: "ws",
        sourceClass: "chat",
        cycleAt: CYCLE_AT,
        // @ts-expect-error — a bare `string` is not `StorableErrorText`. If this
        // row stops erroring, the brand has been removed or widened and the
        // failure writer will accept empty and NUL-bearing messages again.
        lastError: "an unsanitized message",
      });
    expect(typeof unreachable).toBe("function");
  });

  test("a raw string is not assignable to updateClassFailureRows' lastError", () => {
    const unreachable = (): unknown =>
      updateClassFailureRows({
        sourceClass: "chat",
        cycleAt: CYCLE_AT,
        // @ts-expect-error — same rule, the class-wide writer. Branding one
        // writer and not the other is exactly the sibling gap #5032 records.
        lastError: "an unsanitized message",
        workspaceIds: ["ws"],
      });
    expect(typeof unreachable).toBe("function");
  });

  test("the POSITIVE control: storableErrorText's output IS assignable to both", () => {
    // ⚠️ Without this, a `lastError: never` would satisfy both rows above while
    // accepting nothing at all — two negatives passing on a writer no production
    // call site could reach.
    const sanitized = storableErrorText("slack token revoked");
    const unreachable = (): unknown[] => [
      recordFailureRow({
        workspaceId: "ws",
        sourceClass: "chat",
        cycleAt: CYCLE_AT,
        lastError: sanitized,
      }),
      updateClassFailureRows({
        sourceClass: "chat",
        cycleAt: CYCLE_AT,
        lastError: sanitized,
        workspaceIds: ["ws"],
      }),
    ];
    expect(typeof unreachable).toBe("function");
    // …and the mint still applies its rules, so the control is a real value
    // rather than merely a type that type-checks. Upcast to `string` before
    // comparing, the way #5230's mint test does: the brand is compile-time, and
    // `toBe` demands the same type on both sides — itself a small proof that the
    // brand is nominal rather than an alias for `string`.
    const asText: string = sanitized;
    const fallback: string = storableErrorText("");
    expect(fallback).toContain("without reporting a reason");
    expect(asText).toBe("slack token revoked");
  });
});

// ── 2. the writer set ───────────────────────────────────────────────────────

const BRAIN_DIR = resolve(import.meta.dir, "..");
const API_SRC = resolve(BRAIN_DIR, "..", "..");
/** `ee/` is source-available and imports `@atlas/api` from 96 files, measured. */
const EE_SRC = resolve(API_SRC, "..", "..", "..", "ee", "src");

/** The one file allowed to write a VALUE into the column. */
const OWNER_FILE = "coverage-enumeration.ts";
/** The same file, relative to `API_SRC`, for the tree-wide scans. */
const OWNER_REL = "lib/brain/coverage-enumeration.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Tests and mocks write their own fixture SQL — `coverage-snapshot-pg.test.ts`
    // inserts a deliberately-empty `last_error` to prove the CHECK bites. Scanning
    // them would report the proof of the rule as a breach of it. Migrations are
    // excluded for the same reason: they are the DDL, not a runtime writer.
    if (entry === "__tests__" || entry === "__mocks__" || entry === "migrations") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...sourceFiles(abs));
      continue;
    }
    if (entry.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * Every `last_error = <value>` assignment in `text`.
 *
 * Case-insensitive, and the value class admits a quoted literal. Both were holes
 * in the first cut: Postgres does not care about identifier case, and the
 * original class (`[A-Za-z0-9_.$[\]]+`) could not match a quote — so
 * `SET last_error = ''`, the single value the CHECK constraint refuses, produced
 * no match at all and was permitted silently.
 *
 * Only the SET form is matched. Both statements that write the column today
 * carry an `ON CONFLICT DO UPDATE SET last_error = …`, so the equality below
 * sees them, and REWRITING either to drop its SET would drop the count and red
 * the suite. A NEW plain `INSERT … (…, last_error) VALUES (…)` with no
 * `ON CONFLICT` matches nothing and moves no count — measured — so it is
 * unpinned, like the other addition-direction gaps the header lists.
 */
function lastErrorAssignments(text: string): string[] {
  const found: string[] = [];
  // `"?last_error"?` — Postgres accepts a QUOTED IDENTIFIER, and
  // `SET "last_error" = $1` broke the match because the closing quote sat
  // between the name and the `=`. That is not exotic syntax invented for a
  // fixture: `api/routes/admin-mfa-reset.ts` and `lib/staging/seed.ts` both use
  // quoted identifiers in production SQL today.
  for (const match of text.matchAll(/"?last_error"?\s*=\s*('[^']*'|[A-Za-z0-9_.$[\]]+)/gi)) {
    const value = match[1];
    if (value !== undefined) found.push(value);
  }
  return found;
}

/** Occurrences of `needle` in `text`, as a count. */
function countOf(text: string, needle: RegExp): number {
  return [...text.matchAll(needle)].length;
}

describe("no unbranded sibling may write brain_coverage_cycle.last_error", () => {
  const brainFiles = sourceFiles(BRAIN_DIR);
  const ownerText = readFileSync(join(BRAIN_DIR, OWNER_FILE), "utf8");

  test("the scan reaches lib/brain and finds the owner file", () => {
    // The vacuity floor. Every other assertion here is DISCOVERED, so a
    // directory rename or a recursion bug would otherwise leave the suite green
    // having read nothing.
    expect(brainFiles.length).toBeGreaterThan(10);
    expect(brainFiles.map((f) => relative(BRAIN_DIR, f))).toContain(OWNER_FILE);
  });

  test("exactly two raw-SQL VALUE writes exist, both in the owner file", () => {
    const writes: string[] = [];
    for (const abs of brainFiles) {
      const rel = relative(BRAIN_DIR, abs);
      for (const value of lastErrorAssignments(readFileSync(abs, "utf8"))) {
        // `= NULL` is RECORD_SUCCESS_SQL clearing the column on a good cycle,
        // and needs no sanitizing — the CHECK is `IS NULL OR <> ''`.
        if (value.toUpperCase() === "NULL") continue;
        writes.push(`${rel} last_error = ${value}`);
      }
    }

    // ⚠️ An EQUALITY on the whole list, not a count plus a filter. A third
    // writer — in this file or a new sibling — must red here even if its value
    // token duplicates one below, and what a reader gets is the offending
    // file-and-value rather than "expected 2, got 3".
    //
    // ⚠️ NO LINE NUMBERS, deliberately. Pinning them would red this suite on any
    // edit ABOVE either statement — failing on correct changes, which is how a
    // gate earns an exemption comment instead of a fix.
    //
    // If you are adding a writer: route its text through `storableErrorText`,
    // give it a `lastError: StorableErrorText` parameter like the two in
    // `coverage-enumeration.ts`, and add it here. If you are adding a READ, this
    // assertion should not have moved — check the regex.
    expect(writes.sort()).toEqual([
      `${OWNER_FILE} last_error = $3`,
      `${OWNER_FILE} last_error = EXCLUDED.last_error`,
    ]);
  });

  test("RECORD_FAILURE_SQL is referenced exactly once beyond its declaration", () => {
    // The case the list above cannot see: a third writer that adds NO new SQL
    // because it re-binds the existing statement.
    //
    // ⚠️ EVERY reference, not `internalQuery(\s*RECORD_FAILURE_SQL`. The anchored
    // form was blind to `withBrainTransaction((tx) => tx.query(RECORD_FAILURE_SQL,
    // […, rawString]))` — which adds no new `last_error =` text either, so BOTH
    // halves missed it. This file already uses `withBrainTransaction`, so that is
    // the shape a future writer would naturally reach for.
    //
    // Three occurrences: the `const` declaration, one doc reference inside
    // `CoveragePersistReport`'s header, and the single bind in `recordFailureRow`.
    const refs = countOf(ownerText, /\bRECORD_FAILURE_SQL\b/g);
    expect(refs).toBe(3);
  });

  test("the brand has exactly one mint, and each writer exactly one caller", () => {
    // ⚠️ A second minter is a sibling PRODUCER — the #5032 shape one level up
    // from the writers — and the arithmetic above cannot see it: minting moves
    // neither the write list nor the constant's reference count.
    expect(countOf(ownerText, /as StorableErrorText\b/g)).toBe(1);

    // ⚠️ AND THE CAST COUNT ALONE IS NOT THE PROPERTY. Counting casts in the
    // owner file missed a minter in ANY OTHER file — measured green for
    // `lib/brain/zz.ts` and `lib/scheduler/zz.ts` alike — because
    // `StorableErrorText` is an EXPORTED type. It also missed a cast-free minter
    // that simply declares the return type and launders the value
    // (`return JSON.parse(JSON.stringify(raw))`).
    //
    // What holds instead is containment of the TYPE NAME across `packages/api/src`
    // AND `ee/src`. (Round 2 widened the caller scan and the Drizzle scan to the
    // whole tree and left this one on `ownerText` — the same asymmetry, surviving
    // one fix over. `ee/` is included because 96 files there import `@atlas/api`,
    // measured, and this repo has a standing lesson about audit greps that stop
    // at `packages/`.)
    //
    // ⚠️ NARROWER THAN "there is nowhere to declare a second mint", which an
    // earlier version of this comment claimed. Three shapes compile without ever
    // naming the type — `as never`, `as unknown as ReturnType<typeof
    // storableErrorText>`, and `Parameters<typeof recordFailureRow>[0]["lastError"]`
    // — so they are unpinned, and they are on the header's list. This assertion
    // pins the spelling, which is the one a sibling minter would naturally use.
    const namers = [...sourceFiles(API_SRC), ...sourceFiles(EE_SRC)]
      .filter((abs) => relative(API_SRC, abs).replaceAll("\\", "/") !== OWNER_REL)
      .filter((abs) => /\bStorableErrorText\b/.test(readFileSync(abs, "utf8")))
      .map((abs) => relative(API_SRC, abs).replaceAll("\\", "/"));
    expect(namers).toEqual([]);

    // And the call-site counts are what make EXPORTING the two writers safe
    // rather than merely argued-safe in a doc comment. `recordFailureRow` is an
    // upsert: a new caller does not just write a row, it INVENTS one for a
    // (workspace, class) the cycle may never have attempted.
    //
    // TWO occurrences each: the declaration and the one call.
    //
    // ⚠️ `\s*\(`, not `\(\{`. Anchoring on the object literal excluded the
    // declaration for free, but it also made the count blind to
    // `recordFailureRow(args)` — a second caller passing a variable moved
    // NEITHER this count nor `RECORD_FAILURE_SQL`'s (a caller adds no SQL
    // reference) nor the write list. Counting both forms and expecting 2 keeps
    // the declaration in the total and sees every call shape.
    expect(countOf(ownerText, /\brecordFailureRow\s*\(/g)).toBe(2);
    expect(countOf(ownerText, /\bupdateClassFailureRows\s*\(/g)).toBe(2);

    // ⚠️ THE WHOLE API TREE, not just `lib/brain/**`. This assertion is what
    // makes exporting the writers a measurement rather than a promise, and the
    // export is reachable from anywhere in `@atlas/api` — `storableErrorText` is
    // exported too, so any module can mint a valid `StorableErrorText` and call
    // the UPSERT. Scoping it to `lib/brain/**` measured the one place the export
    // was not the risk. (The Drizzle assertion below already reasoned its way to
    // the wider scope; this one did not follow, which is the gap.)
    const callersElsewhere = sourceFiles(API_SRC)
      .filter((abs) => relative(API_SRC, abs).replaceAll("\\", "/") !== OWNER_REL)
      .filter((abs) =>
        /\b(recordFailureRow|updateClassFailureRows)\s*\(/.test(readFileSync(abs, "utf8")),
      )
      .map((abs) => relative(API_SRC, abs).replaceAll("\\", "/"));
    expect(callersElsewhere).toEqual([]);
  });

  test("no Drizzle WRITE targets brainCoverageCycle anywhere in the API tree", () => {
    // ⚠️ THE SHAPE THE RAW-SQL SCAN STRUCTURALLY CANNOT SEE.
    // `db.update(brainCoverageCycle).set({ lastError })` spells neither the
    // column nor the table, so every assertion above passes while an unsanitized
    // write lands. `schema.ts` really does export `brainCoverageCycle`, so this
    // is reachable rather than hypothetical.
    //
    // Scanned across the whole API source tree, not just `lib/brain/**`, because
    // the writers are exported and a caller in `lib/scheduler/` or
    // `api/routes/` would be outside the narrower scope. (The raw-SQL scan stays
    // narrow for the opposite reason: `last_error` is also a column on
    // `crm_outbox`, `lead_outbox`, `email_outbox` and the billing teardown
    // tables, so a tree-wide scan for it would be dominated by writes this rule
    // says nothing about. The symbol is table-specific where the column is not.)
    //
    // ⚠️ WRITE FORMS, not the bare symbol — and the difference bit in both
    // directions. A bare-symbol allowlist of file NAMES admitted a real
    // `db.update(brainCoverageCycle).set({ lastError: raw })` inside any
    // allowlisted file, and `lib/db/internal.ts` was on that list only because it
    // happens to declare a local `const brainCoverageCycle` for its purge DELETE
    // — an identifier collision, not a Drizzle use. In the other direction it
    // red-flagged a legitimate READ, contradicting this file's own "reads are
    // permitted" rule two sections up. Matching `.update(`/`.insert(` removes
    // both: the expected set is empty, so there is no allowlist to rot and no
    // read to trip it.
    const writers = sourceFiles(API_SRC)
      .filter((abs) =>
        /\.\s*(update|insert)\s*\(\s*brainCoverageCycle\b/.test(readFileSync(abs, "utf8")),
      )
      .map((abs) => relative(API_SRC, abs).replaceAll("\\", "/"))
      .sort();
    expect(writers).toEqual([]);
  });
});
