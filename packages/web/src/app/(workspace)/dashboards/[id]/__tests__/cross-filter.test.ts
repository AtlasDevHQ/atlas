/**
 * Cross-filter compatibility + active-filter derivation (#3213).
 *
 * These pure helpers decide which cards a cross-filter touches (so the page can
 * mark the rest) and which chips the filter bar shows. The placeholder scanner
 * mirrors the server-side binder's skip rules — a `:name` inside a string
 * literal / comment / cast is NOT a bound param — so the compatibility marking
 * agrees with how the render endpoint actually binds.
 */
import { describe, expect, test } from "bun:test";
import type { DashboardCard, DashboardParameter } from "@/ui/lib/types";
import {
  extractCardPlaceholders,
  cardBoundPlaceholders,
  isCardAffectedByFilters,
  incompatibleCardIds,
  activeFilters,
} from "../cross-filter";

/** A KPI card that binds a parameter ONLY in its `comparisonSql` (#4321): the
 *  headline is period-agnostic but the delta compares a window. */
function kpiComparisonOnlyCard(id: string, primarySql: string, comparisonSql: string): DashboardCard {
  return {
    ...chartCard(id, primarySql),
    chartConfig: {
      type: "kpi",
      categoryColumn: "label",
      valueColumns: ["total"],
      kpi: { comparisonSql },
    },
  };
}

function chartCard(id: string, sql: string): DashboardCard {
  return {
    id,
    dashboardId: "dash-1",
    position: 0,
    title: id,
    kind: "chart",
    sql,
    chartConfig: { type: "bar", categoryColumn: "stage", valueColumns: ["amount"] },
    content: null,
    cachedColumns: null,
    cachedRows: null,
    cachedAt: null,
    connectionGroupId: null,
    layout: null,
    annotations: [],
    createdAt: "2026-04-25T12:00:00Z",
    updatedAt: "2026-04-25T12:00:00Z",
  };
}

function textCard(id: string): DashboardCard {
  return { ...chartCard(id, ""), kind: "text", sql: "", chartConfig: null, content: "## Section" };
}

describe("extractCardPlaceholders", () => {
  test("collects distinct :name placeholders", () => {
    const names = extractCardPlaceholders(
      "SELECT * FROM t WHERE created_at >= :date_from AND created_at < :date_to AND region = :region",
    );
    expect([...names].sort()).toEqual(["date_from", "date_to", "region"]);
  });

  test("dedupes a placeholder used more than once", () => {
    expect([...extractCardPlaceholders("WHERE a = :region OR b = :region")]).toEqual(["region"]);
  });

  test("ignores :: casts (not placeholders)", () => {
    expect([...extractCardPlaceholders("SELECT id::text FROM t")]).toEqual([]);
  });

  test("ignores a colon-name inside a single-quoted string literal", () => {
    // The server would bind nothing here, so the card is genuinely unaffected.
    expect([...extractCardPlaceholders("SELECT ':region' AS lit, x = :real FROM t")]).toEqual([
      "real",
    ]);
  });

  test("ignores a colon-name inside a line comment", () => {
    expect([...extractCardPlaceholders("SELECT 1 -- filter by :region\nWHERE x = :real")]).toEqual([
      "real",
    ]);
  });

  test("ignores a colon-name inside a block comment", () => {
    expect([...extractCardPlaceholders("SELECT 1 /* :region */ WHERE x = :real")]).toEqual(["real"]);
  });

  test("ignores a colon-name inside a double-quoted identifier", () => {
    expect([...extractCardPlaceholders('SELECT ":region" FROM t WHERE x = :real')]).toEqual(["real"]);
  });

  test("returns an empty set for SQL with no placeholders", () => {
    expect([...extractCardPlaceholders("SELECT * FROM orders")]).toEqual([]);
  });
});

describe("isCardAffectedByFilters", () => {
  const bound = chartCard("a", "SELECT * FROM t WHERE region = :region");
  const unbound = chartCard("b", "SELECT * FROM t");

  test("no active filters → every card is affected (nothing incompatible)", () => {
    expect(isCardAffectedByFilters(bound, [])).toBe(true);
    expect(isCardAffectedByFilters(unbound, [])).toBe(true);
  });

  test("a card binding an active param is affected", () => {
    expect(isCardAffectedByFilters(bound, ["region"])).toBe(true);
  });

  test("a card binding none of the active params is NOT affected", () => {
    expect(isCardAffectedByFilters(unbound, ["region"])).toBe(false);
  });

  test("a card binding at least one active param (of several) is affected", () => {
    const card = chartCard("c", "SELECT * FROM t WHERE created_at >= :date_from");
    expect(isCardAffectedByFilters(card, ["region", "date_from"])).toBe(true);
  });

  test("a text/section card is never affected", () => {
    expect(isCardAffectedByFilters(textCard("t"), ["region"])).toBe(false);
  });

  // #4321 — the "Not filtered" badge must account for a card that binds the
  // parameter ONLY in its comparisonSql.
  test("a KPI card that binds the param only in comparisonSql IS affected (not 'Not filtered')", () => {
    const card = kpiComparisonOnlyCard(
      "kpi",
      "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders",
      "SELECT SUM(amount) AS total FROM orders WHERE created_at >= :date_from AND created_at < :date_to",
    );
    // The primary SQL binds nothing; the comparison binds :date_from/:date_to.
    expect(isCardAffectedByFilters(card, ["date_from"])).toBe(true);
  });

  test("a KPI card binding the param in neither sql nor comparisonSql is still unaffected", () => {
    const card = kpiComparisonOnlyCard(
      "kpi",
      "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders",
      "SELECT SUM(amount) AS total FROM orders WHERE created_at >= :date_from",
    );
    expect(isCardAffectedByFilters(card, ["region"])).toBe(false);
  });
});

describe("cardBoundPlaceholders (#4321 — sql + comparisonSql)", () => {
  test("unions the primary sql and the KPI comparisonSql placeholders", () => {
    const card = kpiComparisonOnlyCard(
      "kpi",
      "SELECT SUM(amount) AS total FROM orders WHERE region = :region",
      "SELECT SUM(amount) AS total FROM orders WHERE created_at >= :date_from",
    );
    expect([...cardBoundPlaceholders(card)].sort()).toEqual(["date_from", "region"]);
  });

  test("a card with no comparisonSql binds only its primary sql placeholders", () => {
    expect([...cardBoundPlaceholders(chartCard("a", "WHERE region = :region"))]).toEqual(["region"]);
  });

  test("an autoComparison KPI binds via its primary sql (comparison re-runs the same sql)", () => {
    // autoComparison shifts the card's OWN sql window, so the bound set is the
    // primary scan — a param the primary sql binds makes the card affected.
    const card: DashboardCard = {
      ...chartCard("kpi", "SELECT SUM(amount) FROM orders WHERE created_at >= :date_from"),
      chartConfig: { type: "kpi", categoryColumn: "label", valueColumns: ["total"], kpi: { autoComparison: true } },
    };
    expect([...cardBoundPlaceholders(card)]).toEqual(["date_from"]);
    expect(isCardAffectedByFilters(card, ["date_from"])).toBe(true);
  });
});

describe("incompatibleCardIds (#4321 — comparisonSql-only binding)", () => {
  test("a KPI card binding the filter only in comparisonSql is NOT marked incompatible", () => {
    const kpi = kpiComparisonOnlyCard(
      "kpi",
      "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders",
      "SELECT SUM(amount) AS total FROM orders WHERE created_at >= :date_from",
    );
    const plain = chartCard("plain", "SELECT count(*) FROM t");
    // Only 'plain' (binds nothing) is incompatible; the comparison-only KPI is not.
    expect(incompatibleCardIds([kpi, plain], ["date_from"])).toEqual(new Set(["plain"]));
  });
});

describe("incompatibleCardIds", () => {
  const cards = [
    chartCard("bound", "SELECT * FROM t WHERE region = :region"),
    chartCard("unbound", "SELECT count(*) FROM t"),
    textCard("section"),
  ];

  test("no active filters → no card is incompatible", () => {
    expect(incompatibleCardIds(cards, [])).toEqual(new Set());
  });

  test("marks only the chart cards that bind none of the active params", () => {
    // 'unbound' has no :region; 'section' is text (never marked); 'bound' matches.
    expect(incompatibleCardIds(cards, ["region"])).toEqual(new Set(["unbound"]));
  });
});

describe("activeFilters", () => {
  const params: DashboardParameter[] = [
    { key: "date_from", type: "date", default: null, label: "From" },
    { key: "region", type: "text", default: null, label: "Region" },
  ];

  test("maps each active override to a chip with the parameter's label, in declared order", () => {
    expect(activeFilters({ region: "us", date_from: "2026-01-01" }, params)).toEqual([
      { key: "date_from", label: "From", value: "2026-01-01" },
      { key: "region", label: "Region", value: "us" },
    ]);
  });

  test("drops null / empty values", () => {
    expect(activeFilters({ region: "", date_from: null }, params)).toEqual([]);
  });

  test("drops overrides that name no declared parameter (stale URL state)", () => {
    expect(activeFilters({ ghost: "x", region: "eu" }, params)).toEqual([
      { key: "region", label: "Region", value: "eu" },
    ]);
  });

  test("stringifies a numeric override value", () => {
    const numParams: DashboardParameter[] = [{ key: "limit_n", type: "number", default: null, label: "Limit" }];
    expect(activeFilters({ limit_n: 5 }, numParams)).toEqual([
      { key: "limit_n", label: "Limit", value: "5" },
    ]);
  });
});
