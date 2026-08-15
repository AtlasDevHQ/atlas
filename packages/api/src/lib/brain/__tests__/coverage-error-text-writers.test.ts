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
 *    never naming the type. The scan below is what does, and it is scoped to
 *    `lib/brain/**` rather than to one file so a new SIBLING file is caught too.
 *
 * ## The scan's instrument is a COUNT, and that is deliberate
 *
 * An early draft tried to locate each write's enclosing construct with
 * `lastIndexOf(name, index)`. Measured useless: both allowed names appear in
 * doc comments and declarations ABOVE any later line, so every new write in the
 * file — however unbranded — would have reported an enclosing construct. What
 * actually holds is arithmetic: the number of value writes is pinned at exactly
 * two, and `RECORD_FAILURE_SQL`'s reference count is pinned at exactly one
 * beyond its declaration. A third writer moves one of those numbers whether it
 * writes new SQL or re-binds the existing statement, and there is no way to add
 * one that moves neither.
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
        cycleIso: "2026-08-15T00:00:00.000Z",
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
        cycleIso: "2026-08-15T00:00:00.000Z",
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
        cycleIso: "2026-08-15T00:00:00.000Z",
        lastError: sanitized,
      }),
      updateClassFailureRows({
        sourceClass: "chat",
        cycleIso: "2026-08-15T00:00:00.000Z",
        lastError: sanitized,
        workspaceIds: ["ws"],
      }),
    ];
    expect(typeof unreachable).toBe("function");
    // …and the mint still applies its rules, so the control is a real value
    // rather than merely a type that type-checks. (The NUL half is pinned
    // end-to-end against a real Postgres by `coverage-snapshot-pg.test.ts`.)
    //
    // Upcast to `string` before comparing, the way #5230's mint test does: the
    // brand is compile-time, and `toBe` is typed to demand the same type on both
    // sides — which is itself a small proof that the brand is nominal rather
    // than an alias for `string`.
    const asText: string = sanitized;
    const fallback: string = storableErrorText("");
    expect(fallback).toContain("without reporting a reason");
    expect(asText).toBe("slack token revoked");
  });
});

// ── 2. the writer set ───────────────────────────────────────────────────────

const BRAIN_DIR = resolve(import.meta.dir, "..");

/** The one file allowed to write a VALUE into the column. */
const OWNER_FILE = "coverage-enumeration.ts";

function brainSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Tests and mocks write their own fixture SQL — `coverage-snapshot-pg.test.ts`
    // inserts a deliberately-empty `last_error` to prove the CHECK bites. Scanning
    // them would report the proof of the rule as a breach of it.
    if (entry === "__tests__" || entry === "__mocks__") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...brainSourceFiles(abs));
      continue;
    }
    if (entry.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * Every `last_error = <value>` assignment in `text`.
 *
 * Only the SET form is matched, and that is sufficient here rather than a
 * simplification: both INSERTs naming `last_error` in a column list also carry
 * an `ON CONFLICT DO UPDATE SET last_error = …` for the same value, so against
 * this table's upsert shape an INSERT-only writer is not expressible. The count
 * assertion is what keeps that claim honest — a statement that ever wrote the
 * column without a SET would drop the found count and red this suite, rather
 * than letting it go quietly blind.
 */
function lastErrorAssignments(text: string): { value: string }[] {
  const found: { value: string }[] = [];
  for (const match of text.matchAll(/last_error\s*=\s*([A-Za-z0-9_.$[\]]+)/g)) {
    const value = match[1];
    if (value === undefined) continue;
    found.push({ value });
  }
  return found;
}

describe("no unbranded sibling may write brain_coverage_cycle.last_error", () => {
  const files = brainSourceFiles(BRAIN_DIR);

  test("the scan reaches lib/brain and finds the owner file", () => {
    // The vacuity floor. Every other assertion here is DISCOVERED, so a
    // directory rename or a recursion bug would otherwise leave the suite green
    // having read nothing.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => relative(BRAIN_DIR, f))).toContain(OWNER_FILE);
  });

  test("exactly two VALUE writes exist, both in the owner file", () => {
    const writes: string[] = [];
    for (const abs of files) {
      const rel = relative(BRAIN_DIR, abs);
      for (const { value } of lastErrorAssignments(readFileSync(abs, "utf8"))) {
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

  test("RECORD_FAILURE_SQL is bound by exactly one call site", () => {
    // The other half of the arithmetic, and the case the list above cannot see:
    // a third writer that adds NO new SQL because it re-binds the existing
    // statement with a raw string. Three occurrences total — the declaration,
    // the doc reference in `persistCoverageSnapshot`'s header, and the one bind
    // inside `recordFailureRow`.
    const text = readFileSync(join(BRAIN_DIR, OWNER_FILE), "utf8");
    const binds = [...text.matchAll(/internalQuery\(\s*RECORD_FAILURE_SQL\b/g)];
    expect(binds).toHaveLength(1);
  });
});
