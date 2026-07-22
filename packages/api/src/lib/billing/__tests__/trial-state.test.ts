/**
 * Tests for the authoritative trial-state module (#4127).
 *
 * `deriveTrialState` is the single derivation of the two CONTEXT.md axes —
 * metered/full (claim) and expired/solvent (Gate 0) — plus the countdown.
 * The matrix here pins the semantics its four predicate consumers
 * (claim-gate, enforcement, grace reaper, trial-eligibility) rely on — the
 * billing/admin/trial routes and the email engine consume the clock helpers; the SQL-fragment
 * tests pin the load-bearing atoms of the generated "unclaimed trial"
 * clauses so the SQL twin can't lose a guard silently.
 *
 * The effective-end / expiry cases were moved here from trial-expiry.test.ts
 * (#3434) when that module folded into trial-state: they pin that a
 * NULL-`trial_ends_at` workspace sees the same date in the banner/billing
 * page that enforcement uses to cut it off.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, relative } from "path";
import { TRIAL_DAYS, TRIAL_GRACE_HOURS } from "../plans";
import {
  deriveTrialState,
  effectiveTrialEndsAt,
  fullTrialEndsAtFrom,
  getOwnerVerification,
  isTrialExpiredAt,
  isTrialTier,
  trialDaysRemaining,
  trialTierSql,
  unclaimedGraceHorizonFrom,
  unclaimedOwnerExistsSql,
} from "../trial-state";
import { _resetPool, type InternalPool, type PlanTier } from "@atlas/api/lib/db/internal";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-06-12T12:00:00.000Z");

function trialWorkspace(overrides: {
  plan_tier?: PlanTier;
  trial_ends_at?: string | Date | null;
  createdAt?: string | Date;
}) {
  return {
    plan_tier: overrides.plan_tier ?? ("trial" as PlanTier),
    trial_ends_at:
      overrides.trial_ends_at === undefined
        ? new Date(NOW.getTime() + 3 * DAY).toISOString()
        : overrides.trial_ends_at,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 1 * DAY).toISOString(),
  };
}

const UNVERIFIED_OWNER = { emailVerified: false, email: "owner@acme.com" };
const VERIFIED_OWNER = { emailVerified: true, email: "owner@acme.com" };

describe("deriveTrialState — the metered/full and expired/solvent axes", () => {
  it("unclaimed trial → metered (the claim-gate predicate)", () => {
    const state = deriveTrialState(trialWorkspace({}), UNVERIFIED_OWNER, NOW);
    expect(state.tier).toBe("trial");
    expect(state.claimed).toBe(false);
    expect(state.metered).toBe(true);
    expect(state.expired).toBe(false);
  });

  it("claimed trial → full (not metered)", () => {
    const state = deriveTrialState(trialWorkspace({}), VERIFIED_OWNER, NOW);
    expect(state.claimed).toBe(true);
    expect(state.metered).toBe(false);
  });

  it("ownerless workspace is vacuously claimed — never metered", () => {
    const state = deriveTrialState(trialWorkspace({}), null, NOW);
    expect(state.claimed).toBe(true);
    expect(state.metered).toBe(false);
  });

  it("non-trial tiers are never metered, never trial-expired, and carry no countdown", () => {
    for (const tier of ["starter", "pro", "business", "locked", "free"] as PlanTier[]) {
      const state = deriveTrialState(
        // Even with an unverified owner and a lapsed trial_ends_at.
        trialWorkspace({ plan_tier: tier, trial_ends_at: new Date(NOW.getTime() - DAY) }),
        UNVERIFIED_OWNER,
        NOW,
      );
      expect(state.metered).toBe(false);
      expect(state.expired).toBe(false);
      expect(state.daysRemaining).toBeNull();
    }
  });

  it("lapsed trial → expired, independent of claim state, countdown floored at 0", () => {
    const ws = trialWorkspace({ trial_ends_at: new Date(NOW.getTime() - 2 * DAY) });
    for (const owner of [UNVERIFIED_OWNER, VERIFIED_OWNER, null]) {
      const state = deriveTrialState(ws, owner, NOW);
      expect(state.expired).toBe(true);
      expect(state.daysRemaining).toBe(0);
    }
  });

  it("an unclaimed-AND-expired trial is both metered and expired (gate ordering decides which block wins)", () => {
    const state = deriveTrialState(
      trialWorkspace({ trial_ends_at: new Date(NOW.getTime() - HOUR) }),
      UNVERIFIED_OWNER,
      NOW,
    );
    expect(state.metered).toBe(true);
    expect(state.expired).toBe(true);
  });

  it("counts whole days remaining (ceil) on a live trial", () => {
    const state = deriveTrialState(
      trialWorkspace({ trial_ends_at: new Date(NOW.getTime() + 5 * DAY - 1000) }),
      VERIFIED_OWNER,
      NOW,
    );
    expect(state.daysRemaining).toBe(5);
    expect(state.expired).toBe(false);
  });

  it("NULL trial_ends_at falls back to createdAt + TRIAL_DAYS on both axes (#3434)", () => {
    const fresh = deriveTrialState(
      trialWorkspace({ trial_ends_at: null, createdAt: new Date(NOW.getTime() - DAY) }),
      VERIFIED_OWNER,
      NOW,
    );
    expect(fresh.expired).toBe(false);
    expect(fresh.daysRemaining).toBe(TRIAL_DAYS - 1);

    const stale = deriveTrialState(
      trialWorkspace({
        trial_ends_at: null,
        createdAt: new Date(NOW.getTime() - (TRIAL_DAYS * DAY + 1)),
      }),
      VERIFIED_OWNER,
      NOW,
    );
    expect(stale.expired).toBe(true);
    expect(stale.daysRemaining).toBe(0);
  });
});

describe("isTrialTier", () => {
  it("only the trial tier is a member", () => {
    expect(isTrialTier("trial")).toBe(true);
    for (const tier of ["starter", "pro", "business", "locked", "free"] as PlanTier[]) {
      expect(isTrialTier(tier)).toBe(false);
    }
  });
});

describe("effectiveTrialEndsAt (moved from trial-expiry, #3434)", () => {
  it("returns trial_ends_at verbatim when set", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(end?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("falls back to createdAt + TRIAL_DAYS when trial_ends_at is null", () => {
    const createdAt = "2026-06-01T00:00:00.000Z";
    const end = effectiveTrialEndsAt({ trial_ends_at: null, createdAt });
    expect(end?.getTime()).toBe(Date.parse(createdAt) + TRIAL_DAYS * DAY);
  });

  it("accepts Date inputs (pg returns Date for timestamptz)", () => {
    const createdAt = new Date("2026-06-01T00:00:00.000Z");
    const end = effectiveTrialEndsAt({ trial_ends_at: null, createdAt });
    expect(end?.getTime()).toBe(createdAt.getTime() + TRIAL_DAYS * DAY);
  });

  it("returns null when both inputs are unparseable", () => {
    expect(
      effectiveTrialEndsAt({ trial_ends_at: "not-a-date", createdAt: "garbage" }),
    ).toBeNull();
  });

  it("falls back to createdAt when trial_ends_at is unparseable", () => {
    const createdAt = "2026-06-01T00:00:00.000Z";
    const end = effectiveTrialEndsAt({ trial_ends_at: "not-a-date", createdAt });
    expect(end?.getTime()).toBe(Date.parse(createdAt) + TRIAL_DAYS * DAY);
  });
});

describe("isTrialExpiredAt", () => {
  it("trial_ends_at in the past → expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: new Date(NOW.getTime() - 1).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(true);
  });

  it("trial_ends_at in the future → not expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: new Date(NOW.getTime() + DAY).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(false);
  });

  it("fallback clock: created more than TRIAL_DAYS ago → expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: null,
      createdAt: new Date(NOW.getTime() - (TRIAL_DAYS * DAY + 1)).toISOString(),
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(true);
  });

  it("fallback clock: created less than TRIAL_DAYS ago → not expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: null,
      createdAt: new Date(NOW.getTime() - (TRIAL_DAYS - 1) * DAY).toISOString(),
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(false);
  });

  it("null effective end (unparseable inputs) → not expired", () => {
    expect(isTrialExpiredAt(null, NOW)).toBe(false);
  });
});

describe("trialDaysRemaining", () => {
  it("floors a lapsed trial at 0 (never negative)", () => {
    expect(
      trialDaysRemaining(
        { trial_ends_at: new Date(NOW.getTime() - 2 * DAY), createdAt: NOW },
        NOW,
      ),
    ).toBe(0);
  });

  it("returns null when neither date input parses", () => {
    expect(
      trialDaysRemaining({ trial_ends_at: "not-a-date", createdAt: "garbage" }, NOW),
    ).toBeNull();
  });
});

describe("trial clock stamps", () => {
  it("fullTrialEndsAtFrom is exactly TRIAL_DAYS out", () => {
    expect(Date.parse(fullTrialEndsAtFrom(NOW.getTime()))).toBe(
      NOW.getTime() + TRIAL_DAYS * DAY,
    );
  });

  it("unclaimedGraceHorizonFrom is exactly TRIAL_GRACE_HOURS out", () => {
    expect(Date.parse(unclaimedGraceHorizonFrom(NOW.getTime()))).toBe(
      NOW.getTime() + TRIAL_GRACE_HOURS * HOUR,
    );
  });

  it("the grace horizon is strictly inside the full trial window (what makes claim extension idempotent)", () => {
    expect(Date.parse(unclaimedGraceHorizonFrom(NOW.getTime()))).toBeLessThan(
      Date.parse(fullTrialEndsAtFrom(NOW.getTime())),
    );
  });
});

/**
 * The write-side/read-side pin (#4354). `fullTrialEndsAtFrom` is now the ONE
 * stamper — `assignSaasTrial`, the boot backfill, and `extendTrialOnClaim`
 * all write what it returns — and `effectiveTrialEndsAt` is the reader Gate 0
 * enforces. If those two ever drift, every new trial is silently mis-dated
 * and enforcement cuts the workspace off on the wrong day. This table walks a
 * fixed set of stamp instants (no `Date.now()` anywhere) and asserts, for
 * each, that what the stamper writes is exactly what the reader reads back —
 * and that a NULL-`trial_ends_at` workspace created at the same instant lands
 * on the same date via the #3434 `createdAt` fallback.
 *
 * The clocks deliberately include both sides of a US and an EU DST
 * transition, a leap day, and a UTC year boundary: the clock is epoch-ms
 * arithmetic, so `TRIAL_DAYS` means exactly `TRIAL_DAYS * 24h` regardless of
 * what the local calendar did in between.
 */
describe("the stamped clock is the enforced clock (write side == read side, #4354)", () => {
  const STAMP_CLOCKS: ReadonlyArray<readonly [label: string, iso: string]> = [
    ["mid-year UTC noon", "2026-06-12T12:00:00.000Z"],
    ["just before US DST spring-forward", "2026-03-08T06:59:59.999Z"],
    ["just after US DST spring-forward", "2026-03-08T07:00:00.000Z"],
    ["just before EU DST fall-back", "2026-10-25T00:59:59.999Z"],
    ["leap day", "2024-02-29T23:30:00.000Z"],
    ["UTC year boundary", "2025-12-31T23:59:59.999Z"],
    ["unix epoch", "1970-01-01T00:00:00.000Z"],
  ];

  for (const [label, iso] of STAMP_CLOCKS) {
    describe(label, () => {
      const stampedAt = Date.parse(iso);
      const stamped = fullTrialEndsAtFrom(stampedAt);
      const expectedEndMs = stampedAt + TRIAL_DAYS * DAY;
      // `createdAt` is irrelevant when trial_ends_at is set — deliberately a
      // wildly different date, so a reader that ignored the stamp would fail.
      const stampedWorkspace = {
        trial_ends_at: stamped,
        createdAt: new Date(stampedAt - 400 * DAY).toISOString(),
      };
      // The #3434 pre-backfill shape: no stamp, clock implied from createdAt.
      const unstampedWorkspace = {
        trial_ends_at: null,
        createdAt: new Date(stampedAt).toISOString(),
      };

      it("the reader reads back exactly the stamped instant", () => {
        expect(effectiveTrialEndsAt(stampedWorkspace)?.getTime()).toBe(expectedEndMs);
      });

      it("the createdAt fallback lands on the same instant the stamper would have written", () => {
        expect(effectiveTrialEndsAt(unstampedWorkspace)?.getTime()).toBe(
          Date.parse(fullTrialEndsAtFrom(stampedAt)),
        );
      });

      it("Gate 0 expires the stamped trial exactly one ms after the stamped end, not before", () => {
        for (const workspace of [stampedWorkspace, unstampedWorkspace]) {
          const end = effectiveTrialEndsAt(workspace);
          expect(isTrialExpiredAt(end, new Date(expectedEndMs))).toBe(false);
          expect(isTrialExpiredAt(end, new Date(expectedEndMs + 1))).toBe(true);
        }
      });

      it("the countdown reads a full TRIAL_DAYS at the stamp instant on both shapes", () => {
        const now = new Date(stampedAt);
        expect(trialDaysRemaining(stampedWorkspace, now)).toBe(TRIAL_DAYS);
        expect(trialDaysRemaining(unstampedWorkspace, now)).toBe(TRIAL_DAYS);
      });
    });
  }
});

/**
 * STRUCTURAL ENFORCEMENT (#4354) — one home for the trial clock.
 *
 * The table above pins that the stamper and the reader agree TODAY; this pins
 * that they still CAN'T disagree tomorrow. `trial-state.ts` is the only module
 * allowed to turn `TRIAL_DAYS` into a duration; every other call site must go
 * through `fullTrialEndsAtFrom`. Sources are DISCOVERED by walking the tree,
 * not enumerated, so a new stamper in a file nobody thought of is auto-enrolled
 * rather than silently skipped. Non-arithmetic reads of the constant (plan
 * metadata like `trialDays: TRIAL_DAYS`, Stripe's `freeTrial: { days }`) are
 * fine — only multiplication into a millisecond span is the drift hazard.
 */
describe("structural: TRIAL_DAYS arithmetic lives only in trial-state.ts (#4354)", () => {
  /** Walk up to the monorepo root (has both `packages/` and `ee/`). */
  function repoRoot(): string {
    let dir = import.meta.dir;
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, "packages")) && existsSync(join(dir, "ee"))) return dir;
      dir = dirname(dir);
    }
    throw new Error(`repo root not found from ${import.meta.dir}`);
  }

  function collectSources(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        collectSources(full, out);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("no source outside trial-state.ts multiplies TRIAL_DAYS into a duration", () => {
    const root = repoRoot();
    const canonical = join(root, "packages/api/src/lib/billing/trial-state.ts");
    const files = [
      ...collectSources(join(root, "packages/api/src"), []),
      ...collectSources(join(root, "ee/src"), []),
    ].filter((f) => f !== canonical);
    // Sanity: the walk actually found the tree it claims to guard.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((file) => {
      // Strip block + line comments — prose citing `NOW() + TRIAL_DAYS` is
      // documentation, not a second stamper.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      return /TRIAL_DAYS\s*\*|\*\s*TRIAL_DAYS/.test(source);
    });

    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
});

describe("SQL fragments — the SQL twin of the unclaimed-trial predicate", () => {
  it("trialTierSql pins tier membership over the given alias", () => {
    expect(trialTierSql("o")).toBe("o.plan_tier = 'trial'");
  });

  it("unclaimedOwnerExistsSql carries every load-bearing guard", () => {
    const sql = unclaimedOwnerExistsSql("o.id");
    // Correlated to the outer org row.
    expect(sql).toContain('m."organizationId" = o.id');
    // Only the OWNER's verification counts.
    expect(sql).toContain("m.role = 'owner'");
    // Unclaimed = the owner's user row is still unverified.
    expect(sql).toContain('u."emailVerified" = false');
    // Set form: EXISTS, not a row-returning join.
    expect(sql).toMatch(/EXISTS\s*\(/);
  });

  it("rejects a non-static ref — the fragment builders never accept request-shaped input", () => {
    expect(() => trialTierSql("o; DROP TABLE organization")).toThrow(/static identifier/);
    expect(() => unclaimedOwnerExistsSql("' OR 1=1")).toThrow(/static identifier/);
    // The legitimate refs all pass.
    expect(() => trialTierSql("o")).not.toThrow();
    expect(() => unclaimedOwnerExistsSql("o.id")).not.toThrow();
    expect(() => unclaimedOwnerExistsSql("$1")).not.toThrow();
  });
});

describe("getOwnerVerification — the row-shape owner read", () => {
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const queries: Array<{ sql: string; params?: unknown[] }> = [];

  function poolReturning(rows: Array<Record<string, unknown>>): InternalPool {
    return {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows, rowCount: rows.length };
      },
    } as unknown as InternalPool;
  }

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test/test";
    queries.length = 0;
  });

  afterAll(() => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("keys on the earliest-created owner (the documented multi-owner tiebreak) and maps the row shape", async () => {
    _resetPool(poolReturning([{ emailVerified: 1, email: "owner@acme.com" }]));

    const owner = await getOwnerVerification("org-1");

    // The multi-owner tiebreak the docstring promises: earliest membership wins.
    expect(queries[0].sql).toMatch(/ORDER BY m\."createdAt" ASC/);
    expect(queries[0].sql).toMatch(/LIMIT 1/);
    expect(queries[0].params).toEqual(["org-1"]);
    // Truthy DB value coerced to a real boolean.
    expect(owner).toEqual({ emailVerified: true, email: "owner@acme.com" });
  });

  it("returns null when no owner row exists (vacuously claimed upstream)", async () => {
    _resetPool(poolReturning([]));
    expect(await getOwnerVerification("org-ownerless")).toBeNull();
  });
});
