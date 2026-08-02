/**
 * The drain's backing-off exclusion, tested without a database.
 *
 * `extract-reconcile-pg.test.ts` covers the behaviour end to end, and it is the
 * better test — it proves a poisoned head does not stall the queue against real
 * Postgres. But it is a `-pg` suite: it SKIPS without `TEST_DATABASE_URL`, so on
 * a normal local run the exclusion has no coverage at all, and the one failure
 * it cannot catch anywhere is the cast. `id <> ALL($2::text[])` against a `uuid`
 * column fails only when Postgres sees it — which, for a developer without a
 * scratch DB, means the first red is in CI.
 *
 * So these are the two assertions that need no DB: the SQL says `uuid`, and the
 * exclusion set is the quarantined population and nothing else.
 */
import { describe, expect, it } from "bun:test";
import {
  BATCH_SIZE,
  DRAIN_EPISODES_SQL,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_PROBE_BASE_MS,
  backingOffIds,
  type QuarantineEntry,
} from "@atlas/api/lib/brain/extract";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    failures: QUARANTINE_AFTER_FAILURES,
    lastFailureAt: NOW.getTime(),
    ...overrides,
  };
}

describe("DRAIN_EPISODES_SQL", () => {
  it("⭐ casts the exclusion to uuid[], the type the column actually is", () => {
    // `brain_episodes.id` is `uuid`. Postgres refuses `uuid <> text` outright
    // rather than coercing, so a `::text[]` cast fails the WHOLE drain — zero
    // episodes extracted, every tick, for every workspace.
    //
    // That is the good direction (loud, not silent), but it is only loud where
    // a real Postgres runs. Pinned here so the local suite catches it too.
    //
    // MUTATION THIS CATCHES: `$2::text[]`.
    expect(DRAIN_EPISODES_SQL).toContain("$2::uuid[]");
    expect(DRAIN_EPISODES_SQL).not.toContain("::text[]");
  });

  it("excludes before it limits, so the batch bound counts episodes we will try", () => {
    // Ordering is the entire fix: `LIMIT` after the exclusion means "25 episodes
    // we will actually attempt", `LIMIT` before it means "25 rows, some of which
    // we skip for free" — which is the stall.
    const wherePos = DRAIN_EPISODES_SQL.indexOf("$2::uuid[]");
    const limitPos = DRAIN_EPISODES_SQL.indexOf("LIMIT");
    expect(wherePos).toBeGreaterThan(-1);
    expect(limitPos).toBeGreaterThan(wherePos);
  });
});

describe("backingOffIds", () => {
  it("returns the episodes still inside their backoff window", () => {
    const ledger = new Map<string, QuarantineEntry>([["ep-quarantined", entry()]]);
    expect(backingOffIds(ledger, NOW)).toEqual(["ep-quarantined"]);
  });

  it("⭐ omits an episode whose probe window has ELAPSED, so it gets retried", () => {
    // Quarantine is a backoff, not a terminal state. An episode whose window has
    // passed must be selected, probed, and allowed to heal — a repaired model
    // recovers the backlog on its own. Excluding it forever would convert the
    // throughput fix into the silent permanent drop this module's ordering
    // exists to avoid.
    //
    // MUTATION THIS CATCHES: excluding on `failures >= QUARANTINE_AFTER_FAILURES`
    // alone, ignoring the window.
    const ledger = new Map<string, QuarantineEntry>([
      ["ep-elapsed", entry({ lastFailureAt: NOW.getTime() - QUARANTINE_PROBE_BASE_MS * 4 })],
    ]);
    expect(backingOffIds(ledger, NOW)).toEqual([]);
  });

  it("omits an episode below the strike threshold — it is failing, not quarantined", () => {
    const ledger = new Map<string, QuarantineEntry>([
      ["ep-one-strike", entry({ failures: QUARANTINE_AFTER_FAILURES - 1 })],
    ]);
    expect(backingOffIds(ledger, NOW)).toEqual([]);
  });

  it("is empty for an empty ledger — `<> ALL('{}')` is true for every row", () => {
    // The empty case needs no special handling at the call site, which is only
    // true if this returns a plain empty array rather than something falsy.
    expect(backingOffIds(new Map(), NOW)).toEqual([]);
  });

  it("can exceed one batch, which is the state the exclusion exists for", () => {
    // If the exclusion set could never exceed BATCH_SIZE there would be nothing
    // to fix: the stall is precisely the case where more than one batch of
    // episodes is poisoned at the head.
    const ledger = new Map<string, QuarantineEntry>();
    for (let i = 0; i < BATCH_SIZE + 5; i++) ledger.set(`ep-${i}`, entry());
    expect(backingOffIds(ledger, NOW)).toHaveLength(BATCH_SIZE + 5);
  });
});
