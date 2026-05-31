/**
 * Unit tests for the per-install OpenAPI spec-refresh interval (#2977).
 *
 * Three contracts are load-bearing here:
 *   - `normalizeSpecRefreshInterval` is the WRITE-path gate: it must CLAMP an
 *     out-of-range-but-usable number and REJECT genuine garbage with an
 *     actionable message — never silently fall back (CLAUDE.md error-handling).
 *   - `getSpecRefreshIntervalMs` is the READ-path reader the #2978 scheduler will
 *     consume (mirrors `getExpertSchedulerIntervalMs`): `off`/drifted → `null`
 *     (skip), every live value → a positive, clamped millisecond count.
 *   - `coerceSpecRefreshInterval` is the fail-soft display coercion for the
 *     detail summary + UI Select (unknown/absent → `off`).
 *   - `evaluateSpecRefreshDue` (#2978) is the scheduler's per-install due-check:
 *     `off`/garbage is NEVER due, and "due" means an interval has elapsed since the
 *     `max(spec_last_checked_at, snapshot.probedAt)` activity watermark.
 */
import { describe, it, expect } from "bun:test";
import {
  coerceSpecRefreshInterval,
  normalizeSpecRefreshInterval,
  getSpecRefreshIntervalMs,
  evaluateSpecRefreshDue,
  parseIsoToMs,
  SPEC_LAST_CHECKED_AT_FIELD,
  DEFAULT_SPEC_REFRESH_INTERVAL,
  MIN_SPEC_REFRESH_HOURS,
  MAX_SPEC_REFRESH_HOURS,
} from "../spec-refresh";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("coerceSpecRefreshInterval — fail-soft display", () => {
  it("passes known values through", () => {
    expect(coerceSpecRefreshInterval("off")).toBe("off");
    expect(coerceSpecRefreshInterval("daily")).toBe("daily");
    expect(coerceSpecRefreshInterval("weekly")).toBe("weekly");
    expect(coerceSpecRefreshInterval("6h")).toBe("6h");
  });

  it("falls back to the default (off) for unknown / absent / wrong-typed values", () => {
    expect(coerceSpecRefreshInterval(undefined)).toBe(DEFAULT_SPEC_REFRESH_INTERVAL);
    expect(coerceSpecRefreshInterval(null)).toBe(DEFAULT_SPEC_REFRESH_INTERVAL);
    expect(coerceSpecRefreshInterval("")).toBe(DEFAULT_SPEC_REFRESH_INTERVAL);
    expect(coerceSpecRefreshInterval("soon")).toBe(DEFAULT_SPEC_REFRESH_INTERVAL);
    expect(coerceSpecRefreshInterval(42)).toBe(DEFAULT_SPEC_REFRESH_INTERVAL);
    expect(coerceSpecRefreshInterval({})).toBe(DEFAULT_SPEC_REFRESH_INTERVAL);
  });

  it("normalizes a drifted custom value to its canonical, clamped form", () => {
    // A hand-edited row of "5000h" displays as the clamped max, not a lie.
    expect(coerceSpecRefreshInterval("5000h")).toBe(`${MAX_SPEC_REFRESH_HOURS}h`);
  });

  it("DEFAULT is off", () => {
    expect(DEFAULT_SPEC_REFRESH_INTERVAL).toBe("off");
  });
});

describe("normalizeSpecRefreshInterval — write-path validate + clamp", () => {
  it("accepts the off sentinel + named presets verbatim", () => {
    for (const v of ["off", "daily", "weekly"]) {
      const r = normalizeSpecRefreshInterval(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(v);
    }
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(normalizeSpecRefreshInterval("  DAILY ")).toEqual({ ok: true, value: "daily" });
    expect(normalizeSpecRefreshInterval("Off")).toEqual({ ok: true, value: "off" });
    expect(normalizeSpecRefreshInterval(" 6H ")).toEqual({ ok: true, value: "6h" });
  });

  it("accepts a custom interval as <N>h, a bare number string, or a number (hours)", () => {
    expect(normalizeSpecRefreshInterval("6h")).toEqual({ ok: true, value: "6h" });
    expect(normalizeSpecRefreshInterval("12")).toEqual({ ok: true, value: "12h" });
    expect(normalizeSpecRefreshInterval(48)).toEqual({ ok: true, value: "48h" });
  });

  it("CLAMPS an out-of-range-but-positive interval (not a rejection)", () => {
    // Below the floor clamps up to the minimum.
    expect(normalizeSpecRefreshInterval("0.5h")).toEqual({ ok: true, value: `${MIN_SPEC_REFRESH_HOURS}h` });
    // Above the ceiling clamps down to the maximum.
    expect(normalizeSpecRefreshInterval("5000h")).toEqual({ ok: true, value: `${MAX_SPEC_REFRESH_HOURS}h` });
    expect(normalizeSpecRefreshInterval(100000)).toEqual({ ok: true, value: `${MAX_SPEC_REFRESH_HOURS}h` });
  });

  it("REJECTS a non-positive / non-finite number with an actionable message (no silent fallback)", () => {
    for (const bad of ["0", "0h", "-3h", -1, 0, "NaNh"]) {
      const r = normalizeSpecRefreshInterval(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("REJECTS unrecognized garbage with a message listing the valid options", () => {
    for (const bad of ["soon", "1 day", "weeklyish", "12x", ""]) {
      const r = normalizeSpecRefreshInterval(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain("off");
        expect(r.message).toContain("daily");
      }
    }
  });

  it("REJECTS wrong-typed input (object / array / bool / null / undefined)", () => {
    for (const bad of [{}, [], true, null, undefined] as unknown[]) {
      expect(normalizeSpecRefreshInterval(bad).ok).toBe(false);
    }
  });
});

describe("getSpecRefreshIntervalMs — read-path reader (mirrors getExpertSchedulerIntervalMs)", () => {
  it("returns null for off — the scheduler skips a null interval", () => {
    expect(getSpecRefreshIntervalMs("off")).toBeNull();
  });

  it("returns null for unknown / drifted / wrong-typed stored values (fail-soft → off)", () => {
    expect(getSpecRefreshIntervalMs(undefined)).toBeNull();
    expect(getSpecRefreshIntervalMs(null)).toBeNull();
    expect(getSpecRefreshIntervalMs("")).toBeNull();
    expect(getSpecRefreshIntervalMs("soon")).toBeNull();
    expect(getSpecRefreshIntervalMs("12x")).toBeNull();
    expect(getSpecRefreshIntervalMs({})).toBeNull();
  });

  it("resolves named presets to their millisecond interval", () => {
    expect(getSpecRefreshIntervalMs("daily")).toBe(24 * HOUR_MS);
    expect(getSpecRefreshIntervalMs("weekly")).toBe(168 * HOUR_MS);
  });

  it("resolves a custom interval (<N>h / bare number) to milliseconds", () => {
    expect(getSpecRefreshIntervalMs("6h")).toBe(6 * HOUR_MS);
    expect(getSpecRefreshIntervalMs("12")).toBe(12 * HOUR_MS);
    expect(getSpecRefreshIntervalMs(48)).toBe(48 * HOUR_MS);
  });

  it("clamps a drifted out-of-range stored value on read (defense for hand-edited rows)", () => {
    expect(getSpecRefreshIntervalMs("5000h")).toBe(MAX_SPEC_REFRESH_HOURS * HOUR_MS);
    expect(getSpecRefreshIntervalMs("0.5h")).toBe(MIN_SPEC_REFRESH_HOURS * HOUR_MS);
  });
});

describe("preset lookup is prototype-pollution safe (own-keys only)", () => {
  // `toString` / `constructor` / `__proto__` are inherited keys on the preset
  // object — `in` would match them and `obj[key] * HOUR_MS` → NaN. Both the write
  // gate and the read path must treat them as garbage, not presets.
  for (const proto of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
    it(`rejects "${proto}" on the write path (not accepted as a preset)`, () => {
      expect(normalizeSpecRefreshInterval(proto).ok).toBe(false);
    });
    it(`reads "${proto}" as null (never a non-finite interval)`, () => {
      expect(getSpecRefreshIntervalMs(proto)).toBeNull();
    });
  }

  it("a prototype-key interval is never due (no NaN leaks into the scheduler)", () => {
    const d = evaluateSpecRefreshDue({ spec_refresh_interval: "toString" }, 1_700_000_000_000);
    expect(d.intervalMs).toBeNull();
    expect(d.due).toBe(false);
  });
});

const NOW = 1_700_000_000_000; // fixed clock for due-calc determinism
const iso = (ms: number) => new Date(ms).toISOString();

describe("parseIsoToMs — JSONB timestamp reader", () => {
  it("parses a valid ISO string to epoch ms", () => {
    expect(parseIsoToMs("2026-05-29T00:00:00.000Z")).toBe(Date.parse("2026-05-29T00:00:00.000Z"));
  });

  it("returns null for non-string / absent / unparseable values (never NaN)", () => {
    expect(parseIsoToMs(undefined)).toBeNull();
    expect(parseIsoToMs(null)).toBeNull();
    expect(parseIsoToMs(123)).toBeNull();
    expect(parseIsoToMs("not-a-date")).toBeNull();
    expect(parseIsoToMs({})).toBeNull();
  });
});

describe("evaluateSpecRefreshDue — scheduler due-check (#2978)", () => {
  it("off / absent / garbage interval is NEVER due (the off-skip AC, enforced app-side)", () => {
    for (const interval of ["off", undefined, "soon", "12x", ""]) {
      const d = evaluateSpecRefreshDue({ spec_refresh_interval: interval }, NOW);
      expect(d.intervalMs).toBeNull();
      expect(d.due).toBe(false);
    }
    // No interval key at all → off by default → never due.
    expect(evaluateSpecRefreshDue({}, NOW).due).toBe(false);
    expect(evaluateSpecRefreshDue(null, NOW).due).toBe(false);
  });

  it("is due when the interval has fully elapsed since the last check", () => {
    const config = {
      spec_refresh_interval: "daily",
      [SPEC_LAST_CHECKED_AT_FIELD]: iso(NOW - DAY_MS - 1),
    };
    const d = evaluateSpecRefreshDue(config, NOW);
    expect(d.intervalMs).toBe(DAY_MS);
    expect(d.due).toBe(true);
  });

  it("is NOT due when the interval has not yet elapsed", () => {
    const config = {
      spec_refresh_interval: "daily",
      [SPEC_LAST_CHECKED_AT_FIELD]: iso(NOW - HOUR_MS), // 1h ago, interval is 24h
    };
    expect(evaluateSpecRefreshDue(config, NOW).due).toBe(false);
  });

  it("treats exactly-elapsed as due (>= boundary)", () => {
    const config = {
      spec_refresh_interval: "daily",
      [SPEC_LAST_CHECKED_AT_FIELD]: iso(NOW - DAY_MS),
    };
    expect(evaluateSpecRefreshDue(config, NOW).due).toBe(true);
  });

  it("a freshly-installed datasource (recent probedAt, no watermark) is NOT immediately due", () => {
    // probedAt acts as the activity watermark when no scheduler check has run yet —
    // so an install probed moments ago at install time isn't re-probed on tick 1.
    const config = {
      spec_refresh_interval: "daily",
      openapi_snapshot: { probedAt: iso(NOW - HOUR_MS) },
    };
    const d = evaluateSpecRefreshDue(config, NOW);
    expect(d.lastActivityMs).toBe(NOW - HOUR_MS);
    expect(d.due).toBe(false);
  });

  it("uses the MAX of watermark and snapshot.probedAt (a recent manual refresh resets the clock)", () => {
    // spec_last_checked_at is stale (2 days ago) but a manual 'Refresh now' just
    // bumped probedAt (1h ago) — max() means the recent activity wins → not due.
    const config = {
      spec_refresh_interval: "daily",
      [SPEC_LAST_CHECKED_AT_FIELD]: iso(NOW - 2 * DAY_MS),
      openapi_snapshot: { probedAt: iso(NOW - HOUR_MS) },
    };
    const d = evaluateSpecRefreshDue(config, NOW);
    expect(d.lastActivityMs).toBe(NOW - HOUR_MS);
    expect(d.due).toBe(false);
  });

  it("with neither watermark nor probedAt, lastActivity is 0 → an interval-configured install is due", () => {
    const d = evaluateSpecRefreshDue({ spec_refresh_interval: "weekly" }, NOW);
    expect(d.lastActivityMs).toBe(0);
    expect(d.due).toBe(true);
  });
});
