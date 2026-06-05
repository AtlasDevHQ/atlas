/**
 * Dashboard parameter binding tests (#2267 — parameters slice).
 *
 * The load-bearing test is `binds an injection-shaped value` — it proves the
 * acceptance criterion that parameter values reach SQL ONLY via the bind array,
 * never interpolated into the query text. The rest pin the scanner's edge cases
 * (`::` casts, string literals, comments, repeated names, dialect differences)
 * and the value/default resolution.
 */
import { describe, it, expect } from "bun:test";
import {
  rewriteNamedPlaceholders,
  bindDashboardParameters,
  resolveDateExpression,
  resolveDashboardParameterValues,
  extractPlaceholderNames,
  derivePriorPeriodValues,
  validateAutoComparison,
  DEFAULT_COMPARISON_DATE_PARAMS,
  DashboardParameterError,
  isBindableDbType,
} from "@atlas/api/lib/dashboard-parameters";
import type { DashboardParameter } from "@useatlas/types";

describe("rewriteNamedPlaceholders", () => {
  it("rewrites :name → $N for postgres in declaration order", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM signups WHERE created_at >= :date_from AND created_at < :date_to",
      "postgres",
    );
    expect(sql).toBe(
      "SELECT * FROM signups WHERE created_at >= $1 AND created_at < $2",
    );
    expect(names).toEqual(["date_from", "date_to"]);
  });

  it("rewrites :name → ? for mysql, one per occurrence", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM signups WHERE created_at >= :date_from AND created_at < :date_to",
      "mysql",
    );
    expect(sql).toBe(
      "SELECT * FROM signups WHERE created_at >= ? AND created_at < ?",
    );
    expect(names).toEqual(["date_from", "date_to"]);
  });

  it("reuses $N for a repeated placeholder (postgres)", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM t WHERE a >= :d OR b >= :d",
      "postgres",
    );
    expect(sql).toBe("SELECT * FROM t WHERE a >= $1 OR b >= $1");
    expect(names).toEqual(["d"]);
  });

  it("emits one ? per occurrence for a repeated placeholder (mysql)", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM t WHERE a >= :d OR b >= :d",
      "mysql",
    );
    expect(sql).toBe("SELECT * FROM t WHERE a >= ? OR b >= ?");
    expect(names).toEqual(["d", "d"]);
  });

  it("does not treat :: PostgreSQL casts as placeholders", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT id::text FROM t WHERE created_at >= :date_from::timestamptz",
      "postgres",
    );
    expect(sql).toBe(
      "SELECT id::text FROM t WHERE created_at >= $1::timestamptz",
    );
    expect(names).toEqual(["date_from"]);
  });

  it("ignores colons inside single-quoted string literals", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM t WHERE note = 'meeting at 5:30' AND a >= :x",
      "postgres",
    );
    expect(sql).toBe(
      "SELECT * FROM t WHERE note = 'meeting at 5:30' AND a >= $1",
    );
    expect(names).toEqual(["x"]);
  });

  it("ignores colons inside escaped ('') string literals", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM t WHERE note = 'it''s 9:00 :nope' AND a = :real",
      "postgres",
    );
    expect(sql).toBe(
      "SELECT * FROM t WHERE note = 'it''s 9:00 :nope' AND a = $1",
    );
    expect(names).toEqual(["real"]);
  });

  it("ignores colons inside double-quoted identifiers", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      'SELECT "weird:col" FROM t WHERE a = :x',
      "postgres",
    );
    expect(sql).toBe('SELECT "weird:col" FROM t WHERE a = $1');
    expect(names).toEqual(["x"]);
  });

  it("ignores colons inside line and block comments", () => {
    const { sql, names } = rewriteNamedPlaceholders(
      "SELECT * FROM t -- filter :ignored\nWHERE a = :x /* also :ignored */",
      "postgres",
    );
    expect(names).toEqual(["x"]);
    expect(sql).toContain("$1");
    expect(sql).toContain("-- filter :ignored");
    expect(sql).toContain("/* also :ignored */");
  });

  it("leaves SQL without placeholders untouched", () => {
    const input = "SELECT count(*) FROM orders WHERE status = 'paid'";
    const { sql, names } = rewriteNamedPlaceholders(input, "postgres");
    expect(sql).toBe(input);
    expect(names).toEqual([]);
  });
});

describe("extractPlaceholderNames", () => {
  it("returns distinct referenced names", () => {
    expect(
      extractPlaceholderNames(
        "SELECT * FROM t WHERE a >= :date_from AND b < :date_to AND c >= :date_from",
      ),
    ).toEqual(["date_from", "date_to"]);
  });
});

describe("bindDashboardParameters", () => {
  it("binds an injection-shaped value instead of interpolating it (acceptance)", () => {
    const malicious = "2020-01-01'; DROP TABLE users; --";
    const { sql, values } = bindDashboardParameters(
      "SELECT * FROM users WHERE created_at >= :date_from",
      { date_from: malicious },
      "postgres",
    );
    // The value lives ONLY in the bind array...
    expect(values).toEqual([malicious]);
    // ...and never appears in the SQL text.
    expect(sql).toBe("SELECT * FROM users WHERE created_at >= $1");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toContain(malicious);
  });

  it("aligns bind values to placeholder order (postgres, deduped)", () => {
    const { sql, values } = bindDashboardParameters(
      "SELECT * FROM t WHERE a >= :date_from AND b < :date_to AND c >= :date_from",
      { date_from: "2026-01-01", date_to: "2026-02-01" },
      "postgres",
    );
    expect(sql).toBe(
      "SELECT * FROM t WHERE a >= $1 AND b < $2 AND c >= $1",
    );
    expect(values).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("repeats bind values per occurrence (mysql)", () => {
    const { sql, values } = bindDashboardParameters(
      "SELECT * FROM t WHERE a >= :d OR b >= :d",
      { d: 5 },
      "mysql",
    );
    expect(sql).toBe("SELECT * FROM t WHERE a >= ? OR b >= ?");
    expect(values).toEqual([5, 5]);
  });

  it("throws on an undeclared placeholder (fail closed)", () => {
    expect(() =>
      bindDashboardParameters(
        "SELECT * FROM t WHERE a >= :unknown",
        { date_from: "2026-01-01" },
        "postgres",
      ),
    ).toThrow(DashboardParameterError);
  });
});

describe("resolveDateExpression", () => {
  const now = new Date("2026-06-03T12:34:56Z");

  it("resolves now / now() / today to the reference date", () => {
    expect(resolveDateExpression("now", now)).toBe("2026-06-03");
    expect(resolveDateExpression("now()", now)).toBe("2026-06-03");
    expect(resolveDateExpression("today", now)).toBe("2026-06-03");
    expect(resolveDateExpression("NOW", now)).toBe("2026-06-03");
  });

  it("resolves relative day/week/month/year expressions", () => {
    expect(resolveDateExpression("now - 30 days", now)).toBe("2026-05-04");
    expect(resolveDateExpression("now() - 30 days", now)).toBe("2026-05-04");
    expect(resolveDateExpression("now - 2 weeks", now)).toBe("2026-05-20");
    expect(resolveDateExpression("now - 1 month", now)).toBe("2026-05-03");
    expect(resolveDateExpression("now - 3 months", now)).toBe("2026-03-03");
    expect(resolveDateExpression("now - 1 year", now)).toBe("2025-06-03");
    expect(resolveDateExpression("now + 7 days", now)).toBe("2026-06-10");
  });

  it("passes through ISO dates and ISO datetimes", () => {
    expect(resolveDateExpression("2024-01-15", now)).toBe("2024-01-15");
    expect(resolveDateExpression("2024-01-15T08:00:00Z", now)).toBe("2024-01-15");
  });

  it("throws on an unparseable expression", () => {
    expect(() => resolveDateExpression("last tuesday", now)).toThrow(
      DashboardParameterError,
    );
    expect(() => resolveDateExpression("now() - 30 fortnights", now)).toThrow(
      DashboardParameterError,
    );
  });
});

describe("resolveDashboardParameterValues", () => {
  const now = new Date("2026-06-03T00:00:00Z");
  const defs: DashboardParameter[] = [
    { key: "date_from", type: "date", default: "now - 30 days", label: "From" },
    { key: "date_to", type: "date", default: "now", label: "To" },
    { key: "region", type: "text", default: "us", label: "Region" },
    { key: "limit_n", type: "number", default: 10, label: "Top N" },
  ];

  it("fills defaults when nothing is supplied", () => {
    expect(resolveDashboardParameterValues(defs, undefined, now)).toEqual({
      date_from: "2026-05-04",
      date_to: "2026-06-03",
      region: "us",
      limit_n: 10,
    });
  });

  it("overrides defaults with supplied (coerced) values", () => {
    const out = resolveDashboardParameterValues(
      defs,
      { date_from: "2026-01-01", region: "eu", limit_n: "25" },
      now,
    );
    expect(out).toEqual({
      date_from: "2026-01-01",
      date_to: "2026-06-03",
      region: "eu",
      limit_n: 25,
    });
  });

  it("ignores supplied keys that aren't declared parameters", () => {
    const out = resolveDashboardParameterValues(
      defs,
      { date_from: "2026-01-01", evil_undeclared: "x" },
      now,
    );
    expect(out).not.toHaveProperty("evil_undeclared");
    expect(out.date_from).toBe("2026-01-01");
  });

  it("rejects an invalid date value", () => {
    expect(() =>
      resolveDashboardParameterValues(defs, { date_from: "not-a-date" }, now),
    ).toThrow(DashboardParameterError);
  });

  it("rejects a non-numeric number value", () => {
    expect(() =>
      resolveDashboardParameterValues(defs, { limit_n: "abc" }, now),
    ).toThrow(DashboardParameterError);
  });

  it("resolves a null default to null", () => {
    const out = resolveDashboardParameterValues(
      [{ key: "q", type: "text", default: null, label: "Q" }],
      undefined,
      now,
    );
    expect(out).toEqual({ q: null });
  });
});

describe("isBindableDbType", () => {
  it("accepts postgres and mysql only", () => {
    expect(isBindableDbType("postgres")).toBe(true);
    expect(isBindableDbType("mysql")).toBe(true);
    expect(isBindableDbType("clickhouse")).toBe(false);
    expect(isBindableDbType("snowflake")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// derivePriorPeriodValues (#3207) — the automatic period-over-period window
// shift. Pure: given resolved values with a [from, to) date window, shift BOTH
// bounds back by the window's length so the same primary SQL runs against the
// immediately-preceding, non-overlapping window of identical size.
// ---------------------------------------------------------------------------

describe("derivePriorPeriodValues", () => {
  it("shifts a window back by its own length (the prior period is adjacent)", () => {
    // [Jan 1, Jan 31) is a 30-day window; the prior 30-day window ends exactly
    // where this one begins → [Dec 2, Jan 1).
    expect(
      derivePriorPeriodValues({ date_from: "2026-01-01", date_to: "2026-01-31" }),
    ).toEqual({ date_from: "2025-12-02", date_to: "2026-01-01" });
  });

  it("handles a short window (5 days)", () => {
    expect(
      derivePriorPeriodValues({ date_from: "2026-03-15", date_to: "2026-03-20" }),
    ).toEqual({ date_from: "2026-03-10", date_to: "2026-03-15" });
  });

  it("rolls correctly across a month boundary", () => {
    // [Mar 1, Mar 8) span 7 → prior [Feb 22, Mar 1). Feb 2026 has 28 days.
    expect(
      derivePriorPeriodValues({ date_from: "2026-03-01", date_to: "2026-03-08" }),
    ).toEqual({ date_from: "2026-02-22", date_to: "2026-03-01" });
  });

  it("rolls correctly across a year boundary", () => {
    expect(
      derivePriorPeriodValues({ date_from: "2026-01-05", date_to: "2026-01-10" }),
    ).toEqual({ date_from: "2025-12-31", date_to: "2026-01-05" });
  });

  it("preserves non-window parameters unchanged", () => {
    expect(
      derivePriorPeriodValues({
        date_from: "2026-03-15",
        date_to: "2026-03-20",
        region: "eu",
        limit_n: 25,
      }),
    ).toEqual({
      date_from: "2026-03-10",
      date_to: "2026-03-15",
      region: "eu",
      limit_n: 25,
    });
  });

  it("honors a custom from/to parameter pair", () => {
    expect(
      derivePriorPeriodValues(
        { start: "2026-03-15", end: "2026-03-20" },
        { from: "start", to: "end" },
      ),
    ).toEqual({ start: "2026-03-10", end: "2026-03-15" });
  });

  it("defaults to the date_from / date_to pair", () => {
    expect(DEFAULT_COMPARISON_DATE_PARAMS).toEqual({ from: "date_from", to: "date_to" });
  });

  it("returns null when a bound is missing", () => {
    expect(derivePriorPeriodValues({ date_from: "2026-03-15" })).toBeNull();
    expect(derivePriorPeriodValues({ date_to: "2026-03-20" })).toBeNull();
  });

  it("returns null when a bound is null or non-string", () => {
    expect(
      derivePriorPeriodValues({ date_from: null, date_to: "2026-03-20" }),
    ).toBeNull();
    expect(
      derivePriorPeriodValues({ date_from: 20260315 as unknown as string, date_to: "2026-03-20" }),
    ).toBeNull();
  });

  it("returns null when a bound is unparseable", () => {
    expect(
      derivePriorPeriodValues({ date_from: "not-a-date", date_to: "2026-03-20" }),
    ).toBeNull();
  });

  it("returns null for an inverted window (from after to)", () => {
    expect(
      derivePriorPeriodValues({ date_from: "2026-03-20", date_to: "2026-03-15" }),
    ).toBeNull();
  });

  it("returns null for a zero-length window (from equals to)", () => {
    // A half-open [from, from) window is empty; there's no period to shift.
    expect(
      derivePriorPeriodValues({ date_from: "2026-03-15", date_to: "2026-03-15" }),
    ).toBeNull();
  });

  it("does not mutate the input values map", () => {
    const input = { date_from: "2026-03-15", date_to: "2026-03-20", region: "eu" };
    derivePriorPeriodValues(input);
    expect(input).toEqual({ date_from: "2026-03-15", date_to: "2026-03-20", region: "eu" });
  });
});

// ---------------------------------------------------------------------------
// validateAutoComparison (#3207) — the shared persistence-path guard: a card
// requesting an automatic prior-period comparison must filter by both window
// params, declared as `date`.
// ---------------------------------------------------------------------------

describe("validateAutoComparison", () => {
  const sql = "SELECT sum(amount) AS total FROM orders WHERE created_at >= :date_from AND created_at < :date_to";
  const dateParams = [
    { key: "date_from", type: "date" as const, default: "now - 30 days", label: "From" },
    { key: "date_to", type: "date" as const, default: "now", label: "To" },
  ];

  it("returns null when autoComparison is not set (nothing to validate)", () => {
    expect(validateAutoComparison(sql, undefined)).toBeNull();
    expect(validateAutoComparison(sql, { comparisonSql: "SELECT 1 AS total" })).toBeNull();
    expect(validateAutoComparison(sql, { autoComparison: false })).toBeNull();
  });

  it("accepts a card that filters by both date-typed window params", () => {
    expect(validateAutoComparison(sql, { autoComparison: true }, dateParams)).toBeNull();
  });

  it("rejects when the SQL does not reference both window params", () => {
    const err = validateAutoComparison("SELECT sum(amount) AS total FROM orders", { autoComparison: true }, dateParams);
    expect(err).toMatch(/autoComparison/i);
    expect(err).toContain(":date_from");
    expect(err).toContain(":date_to");
  });

  it("rejects when only one window bound is referenced", () => {
    const err = validateAutoComparison(
      "SELECT sum(amount) AS total FROM orders WHERE created_at >= :date_from",
      { autoComparison: true },
      dateParams,
    );
    // The missing bound (date_to) is named; date_from also appears in the
    // example clause, so we only assert the genuinely-missing one is flagged.
    expect(err).toMatch(/does not reference :date_to\b/);
  });

  it("rejects when a window param is not declared as a date", () => {
    const err = validateAutoComparison(sql, { autoComparison: true }, [
      { key: "date_from", type: "number", default: 0, label: "From" },
      { key: "date_to", type: "date", default: "now", label: "To" },
    ]);
    expect(err).toMatch(/date parameter/i);
    expect(err).toContain(":date_from");
  });

  it("honours a custom comparisonDateParams pair", () => {
    const customSql = "SELECT sum(amount) AS total FROM orders WHERE created_at >= :start AND created_at < :end";
    const params = [
      { key: "start", type: "date" as const, default: "now - 7 days", label: "Start" },
      { key: "end", type: "date" as const, default: "now", label: "End" },
    ];
    expect(
      validateAutoComparison(customSql, { autoComparison: true, comparisonDateParams: { from: "start", to: "end" } }, params),
    ).toBeNull();
  });

  it("skips the date-type check when no parameter definitions are supplied (reference check only)", () => {
    // Bound-editor path: SQL is available, parameter defs are not.
    expect(validateAutoComparison(sql, { autoComparison: true })).toBeNull();
    expect(validateAutoComparison("SELECT 1", { autoComparison: true })).toMatch(/autoComparison/i);
  });
});
