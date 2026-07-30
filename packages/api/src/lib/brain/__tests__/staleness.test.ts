/**
 * Read-time decay (#4914, ADR-0036 §Temporal).
 *
 * The claims worth pinning are the ones a green build would otherwise hide:
 *
 *   - decay is a PURE read-time derivation — this suite proves structurally
 *     that the module holds no mutating SQL and behaviorally (in
 *     `candidates.test.ts` / `search.test.ts`) that serving a stale fact
 *     emits only SELECTs;
 *   - the SQL surfacing hint and the TypeScript label share one threshold
 *     constant, so a row can never SORT as stale while LABELLING itself fresh;
 *   - a withheld attribution strips the numbers but not the level — a
 *     day-precision age is the withheld "when" restated as arithmetic (#4836);
 *   - `unknown` is the honest arm for a row with no decodable timestamp, and a
 *     future timestamp clamps to age 0 rather than going negative.
 */

import { describe, expect, it } from "bun:test";
import {
  DECAY_AGING_AFTER_DAYS,
  DECAY_STALE_AFTER_DAYS,
  LAST_OBSERVED_AT_SELECT,
  STALE_SURFACING_HINT_SQL,
  computeDecaySignal,
} from "@atlas/api/lib/brain/staleness";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function signal(
  inputs: Partial<{ lastObservedAt: unknown; validFrom: unknown; ingestedAt: unknown }>,
  attribution: "disclose" | "withhold" = "disclose",
) {
  return computeDecaySignal(
    { lastObservedAt: null, validFrom: null, ingestedAt: null, ...inputs },
    attribution,
    NOW,
  );
}

describe("computeDecaySignal — buckets", () => {
  it("labels the three ages exactly at the shared thresholds", () => {
    expect(signal({ lastObservedAt: daysAgo(0) }).level).toBe("fresh");
    expect(signal({ lastObservedAt: daysAgo(DECAY_AGING_AFTER_DAYS - 1) }).level).toBe("fresh");
    expect(signal({ lastObservedAt: daysAgo(DECAY_AGING_AFTER_DAYS) }).level).toBe("aging");
    expect(signal({ lastObservedAt: daysAgo(DECAY_STALE_AFTER_DAYS - 1) }).level).toBe("aging");
    expect(signal({ lastObservedAt: daysAgo(DECAY_STALE_AFTER_DAYS) }).level).toBe("stale");
  });

  it("reports the age and the observation on the disclose arm", () => {
    const observed = daysAgo(200);
    expect(signal({ lastObservedAt: observed })).toEqual({
      level: "stale",
      ageDays: 200,
      lastObservedAt: observed,
    });
  });

  it("clamps a future anchor to age 0 instead of going negative", () => {
    // A fabricated timestamp must not surface as "observed -3 days ago" with
    // the confidence of a real reading.
    const s = signal({ lastObservedAt: daysAgo(-3) });
    expect(s.level).toBe("fresh");
    expect(s.ageDays).toBe(0);
  });

  it("accepts Date instances as well as ISO strings, like the rest of the slice", () => {
    const s = signal({ lastObservedAt: new Date(NOW.getTime() - 200 * 86_400_000) });
    expect(s.level).toBe("stale");
    expect(s.ageDays).toBe(200);
  });
});

describe("computeDecaySignal — anchor chain", () => {
  it("prefers the observation, then validFrom, then ingest", () => {
    expect(
      signal({ lastObservedAt: daysAgo(10), validFrom: daysAgo(300), ingestedAt: daysAgo(300) })
        .level,
    ).toBe("fresh");
    expect(
      signal({ validFrom: daysAgo(50), ingestedAt: daysAgo(300) }),
    ).toEqual({ level: "aging", ageDays: 50, lastObservedAt: null });
    expect(signal({ ingestedAt: daysAgo(200) }).level).toBe("stale");
  });

  it("reports `unknown` with no numbers when nothing decodes", () => {
    expect(signal({})).toEqual({ level: "unknown", ageDays: null, lastObservedAt: null });
    expect(signal({ lastObservedAt: "yesterday", validFrom: "junk", ingestedAt: 42 })).toEqual({
      level: "unknown",
      ageDays: null,
      lastObservedAt: null,
    });
  });

  it("treats an UNSELECTED observation column as drift, not as 'no observations'", () => {
    // `pg` never yields `undefined` for a selected column, so `undefined`
    // means the projection dropped the decay anchor. Falling back to ingest
    // would produce a confident wrong label while the SQL surfacing hint —
    // which interpolates the subquery independently — kept sorting by the
    // real observation: the hint/label disagreement the module forbids. Same
    // undefined-vs-NULL distinction `attributionDecision` draws.
    const drifted = computeDecaySignal(
      { lastObservedAt: undefined, validFrom: null, ingestedAt: daysAgo(5) },
      "disclose",
      NOW,
    );
    expect(drifted).toEqual({ level: "unknown", ageDays: null, lastObservedAt: null });
    // The negative that keeps this arm honest: a SELECTED-but-NULL column is
    // a legitimate "no observations yet" and still earns the fallback anchor.
    expect(signal({ lastObservedAt: null, ingestedAt: daysAgo(5) })).toEqual({
      level: "fresh",
      ageDays: 5,
      lastObservedAt: null,
    });
  });

  it("skips an unparseable observation rather than letting it shadow a real fallback", () => {
    const s = signal({ lastObservedAt: "not-a-date", ingestedAt: daysAgo(5) });
    expect(s).toEqual({ level: "fresh", ageDays: 5, lastObservedAt: null });
  });
});

describe("computeDecaySignal — the withheld arm (#4836)", () => {
  it("strips the numbers but keeps the level when the anchor is an observation", () => {
    // For a singly-corroborated fact the observation IS the withheld
    // `occurredAt`; a day-precision age restates it as arithmetic. The coarse
    // bucket stays honest — ~2 bits reconstruct no moment.
    expect(signal({ lastObservedAt: daysAgo(200) }, "withhold")).toEqual({
      level: "stale",
      ageDays: null,
      lastObservedAt: null,
    });
  });

  it("keeps the numbers when the anchor is one of the claim's disclosed timestamps", () => {
    // `valid_from` / `ingested_at` are on the wire beside the decay view for
    // every reader; withholding an age derived from them protects nothing.
    expect(signal({ validFrom: daysAgo(50) }, "withhold")).toEqual({
      level: "aging",
      ageDays: 50,
      lastObservedAt: null,
    });
  });

  it("is tested against disclose, so a third decision arm lands on the withheld branch", () => {
    // Same polarity as `projectProvenance`: an unrecognized decision must fail
    // closed. The cast spells what a future widening of the union would do.
    const s = computeDecaySignal(
      { lastObservedAt: daysAgo(200), validFrom: null, ingestedAt: null },
      "audit-override" as unknown as "withhold",
      NOW,
    );
    expect(s.ageDays).toBeNull();
    expect(s.lastObservedAt).toBeNull();
  });
});

describe("no write path exists from the decay signal (#4914 acceptance)", () => {
  it("is a pure function of its inputs — no I/O handle to write through", () => {
    const inputs = { lastObservedAt: daysAgo(10), validFrom: daysAgo(20), ingestedAt: daysAgo(30) };
    const frozen = Object.freeze({ ...inputs });
    const a = computeDecaySignal(frozen, "disclose", NOW);
    const b = computeDecaySignal(frozen, "disclose", NOW);
    expect(a).toEqual(b);
    expect(frozen).toEqual(inputs);
  });

  it("ships no mutating SQL anywhere in the module", async () => {
    // The module's whole SQL surface is two exported read fragments. A decay
    // that wrote anything — a stored score, an expiry, a demotion — would need
    // a mutating verb SOMEWHERE in this file, and this pin is what makes the
    // ADR-0036 stance ("decay only surfaces, never auto-demotes") survive a
    // refactor rather than live in a comment. Comments are stripped first so
    // the scan is case-insensitive over CODE — prose may name UPDATE while
    // explaining why there isn't one, and a lowercase `update` in a template
    // literal must not slip an uppercase-only match.
    const source = await Bun.file(new URL("../staleness.ts", import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(update|insert|delete|truncate|alter)\b/i);
    for (const fragment of [LAST_OBSERVED_AT_SELECT, STALE_SURFACING_HINT_SQL]) {
      expect(fragment).not.toMatch(/\b(update|insert|delete|truncate|alter|set)\b/i);
    }
  });

  it("keys the SQL surfacing hint on the same constant as the label", () => {
    // Two derivations of one rule. If the hint stops interpolating the shared
    // threshold, a row can sort as stale while labelling itself aging — the
    // exact drift the shared constant exists to prevent.
    expect(STALE_SURFACING_HINT_SQL).toContain(`days => ${DECAY_STALE_AFTER_DAYS}`);
    expect(STALE_SURFACING_HINT_SQL).toContain(LAST_OBSERVED_AT_SELECT);
    expect(DECAY_AGING_AFTER_DAYS).toBeLessThan(DECAY_STALE_AFTER_DAYS);
  });
});
