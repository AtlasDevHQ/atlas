/**
 * Render tests for the coverage view's presentational pieces (#4521). The pure
 * wire types + the fetch/poll live in `coverage.tsx`; these pin the UI behaviors
 * only a render can catch:
 *
 *   - AC2: clicking a COVERED column fires `onColumnAnchor` with the column's
 *     entity, name, and group, plus the `entity.column` chip label.
 *   - AC3 (containment / ADR-0032): an UNCOVERED table exposes an Enrich
 *     deep-link and NO amendment/"add entity" affordance.
 *   - AC4: a connection still profiling renders a loading state, not an empty one.
 *   - An errored connection surfaces its reason.
 *
 * Plus the #4652 scale behaviors: sections collapse to their summary line by
 * default (an active filter force-expands them), the search/state filters narrow
 * the table list, and long lists mount in `COVERAGE_TABLE_PAGE_SIZE` chunks
 * behind a "Show more" tail. Pre-#4652 suites pass `defaultOpen: true` — they
 * pin row/column behavior, not the collapse.
 *
 * The presentational components are rendered directly (no fetch), mirroring the
 * launchers suite that renders `AnchorLaunchers` / `ActiveAnchorChip` directly.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  ConnectionCoverageSection,
  CoverageFilterBar,
  COVERAGE_TABLE_PAGE_SIZE,
  type ColumnAnchorRequest,
  type TableCoverageState,
  type WireConnectionCoverage,
  type WireTableCoverage,
} from "../coverage";

// next/link needs no router for a plain anchor render — stub it to the bare <a>.
void mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

afterEach(cleanup);

function table(overrides: Partial<WireTableCoverage> = {}): WireTableCoverage {
  return {
    table: "orders",
    rowCount: 4321,
    entity: "orders",
    group: "grp_prod",
    state: "partial",
    coveredColumnCount: 1,
    coverableColumnCount: 2,
    columns: [
      { column: "id", type: "int", isPrimaryKey: true, covered: false, dimension: null, described: false, sampled: false },
      { column: "status", type: "text", isPrimaryKey: false, covered: true, dimension: "status", described: true, sampled: true },
      { column: "amount", type: "numeric", isPrimaryKey: false, covered: false, dimension: null, described: false, sampled: false },
    ],
    ...overrides,
  };
}

function connection(overrides: Partial<WireConnectionCoverage> = {}): WireConnectionCoverage {
  return {
    installId: "conn_1",
    group: "grp_prod",
    dbType: "postgres",
    status: "ready",
    error: null,
    freshness: "profiled 2 days ago",
    coverage: {
      tables: [table()],
      summary: { coveredTables: 0, partialTables: 1, uncoveredTables: 0, totalTables: 1 },
    },
    ...overrides,
  };
}

describe("ConnectionCoverageSection — covered column launches the anchor (#4521 AC2)", () => {
  test("clicking a covered column fires onColumnAnchor with its entity, column, group + label", () => {
    const onColumnAnchor = mock((_req: ColumnAnchorRequest, _label: string) => {});
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection(),
        onColumnAnchor,
        disabled: false,
        defaultOpen: true,
      }),
    );

    // The table row is collapsed by default — expand it to reveal the columns.
    fireEvent.click(getByText("orders"));
    // The covered `status` column is a button; the uncovered `amount` is not.
    fireEvent.click(getByText("status"));

    expect(onColumnAnchor).toHaveBeenCalledTimes(1);
    expect(onColumnAnchor.mock.calls[0]).toEqual([
      { entity: "orders", column: "status", group: "grp_prod" },
      "orders.status",
    ]);
  });

  test("an uncovered column is not clickable (no anchor fired)", () => {
    const onColumnAnchor = mock(() => {});
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection(),
        onColumnAnchor,
        disabled: false,
        defaultOpen: true,
      }),
    );
    fireEvent.click(getByText("orders"));
    // `amount` is uncovered — rendered as a plain marker, clicking it is a no-op.
    fireEvent.click(getByText("amount"));
    expect(onColumnAnchor).not.toHaveBeenCalled();
  });

  test("a covered column in the flat/default group launches with group null (#4521)", () => {
    const onColumnAnchor = mock((_req: ColumnAnchorRequest, _label: string) => {});
    const flat = connection({
      coverage: {
        tables: [table({ group: null })],
        summary: { coveredTables: 0, partialTables: 1, uncoveredTables: 0, totalTables: 1 },
      },
    });
    const { getByText } = render(
      createElement(ConnectionCoverageSection, { connection: flat, onColumnAnchor, disabled: false, defaultOpen: true }),
    );
    fireEvent.click(getByText("orders"));
    fireEvent.click(getByText("status"));
    expect(onColumnAnchor.mock.calls[0]).toEqual([
      { entity: "orders", column: "status", group: null },
      "orders.status",
    ]);
  });
});

describe("ConnectionCoverageSection — all three states + summary (AC1)", () => {
  test("renders the covered state badge and the summary chip counts", () => {
    const ready = connection({
      coverage: {
        tables: [table({ table: "customers", state: "covered", coveredColumnCount: 2, coverableColumnCount: 2 })],
        summary: { coveredTables: 3, partialTables: 2, uncoveredTables: 1, totalTables: 6 },
      },
    });
    const { getByText } = render(
      createElement(ConnectionCoverageSection, { connection: ready, onColumnAnchor: () => {}, disabled: false, defaultOpen: true }),
    );
    // Summary chips reflect the three states (AC1).
    expect(getByText("3 covered")).toBeDefined();
    expect(getByText("2 partial")).toBeDefined();
    expect(getByText("1 uncovered")).toBeDefined();
    // The table's own covered badge renders.
    expect(getByText("covered")).toBeDefined();
  });
});

describe("ConnectionCoverageSection — row is labelled by connection identity, not just group", () => {
  test("a group member shows its own install id plus the shared group as context", () => {
    // A 3-region `g_prod` group renders one row per member; each must be
    // distinguishable, so the label leads with the connection id and shows the
    // group only as context.
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection({ installId: "eu-prod", group: "g_prod" }),
        onColumnAnchor: () => {},
        disabled: false,
      }),
    );
    expect(getByText("eu-prod")).toBeDefined();
    expect(getByText("g_prod")).toBeDefined();
  });

  test("a group-of-one (group === installId) does not repeat the group as context", () => {
    const { getByText, getAllByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection({ installId: "solo", group: "solo" }),
        onColumnAnchor: () => {},
        disabled: false,
      }),
    );
    // The identity renders exactly once — not once as the label AND again as a
    // redundant group-context chip.
    expect(getAllByText("solo")).toHaveLength(1);
    // The "group" context word (rendered as a `group <mono>` span when shown) is
    // absent entirely.
    expect(getByText("solo")).toBeDefined();
    expect(queryByText(/group/)).toBeNull();
  });
});

describe("ConnectionCoverageSection — uncovered routes to enrich, never an amendment (ADR-0032)", () => {
  test("an uncovered table exposes an Enrich deep-link and no add-entity affordance", () => {
    const uncovered = connection({
      coverage: {
        tables: [
          table({ table: "audit_log", entity: null, group: null, state: "uncovered", coveredColumnCount: 0, coverableColumnCount: 0 }),
        ],
        summary: { coveredTables: 0, partialTables: 0, uncoveredTables: 1, totalTables: 1 },
      },
    });
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, { connection: uncovered, onColumnAnchor: () => {}, disabled: false, defaultOpen: true }),
    );
    fireEvent.click(getByText("audit_log"));
    const enrich = getByText("Enrich").closest("a");
    expect(enrich).not.toBeNull();
    // The deep-link targets the connection's install id (the wizard door).
    expect(enrich?.getAttribute("href")).toContain("conn_1");
    // No amendment / add-entity affordance anywhere (containment).
    expect(queryByText(/add entity/i)).toBeNull();
    expect(queryByText(/propose/i)).toBeNull();
  });
});

describe("ConnectionCoverageSection — non-ready statuses", () => {
  test("a profiling connection renders a loading state (AC4), not an empty one", () => {
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection({ status: "profiling", coverage: null, freshness: null }),
        onColumnAnchor: () => {},
        disabled: false,
      }),
    );
    expect(getByText(/Profiling this connection/i)).toBeDefined();
  });

  test("an errored connection surfaces its reason", () => {
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection({ status: "error", coverage: null, error: "could not resolve a live connection" }),
        onColumnAnchor: () => {},
        disabled: false,
      }),
    );
    expect(getByText(/could not resolve a live connection/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// #4652 — scale behaviors for large multi-connection groups
// ---------------------------------------------------------------------------

/** A connection whose coverage holds the given tables (summary values arbitrary). */
function connectionWithTables(tables: WireTableCoverage[]): WireConnectionCoverage {
  return connection({
    coverage: {
      tables,
      summary: { coveredTables: 0, partialTables: tables.length, uncoveredTables: 0, totalTables: tables.length },
    },
  });
}

describe("ConnectionCoverageSection — collapse-by-default (#4652)", () => {
  test("starts collapsed: the summary line renders, the table rows do not", () => {
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection({
          coverage: {
            tables: [table()],
            summary: { coveredTables: 3, partialTables: 2, uncoveredTables: 1, totalTables: 6 },
          },
        }),
        onColumnAnchor: () => {},
        disabled: false,
      }),
    );
    // The summary line IS the collapsed view…
    expect(getByText("3 covered")).toBeDefined();
    expect(getByText("2 partial")).toBeDefined();
    expect(getByText("1 uncovered")).toBeDefined();
    // …and no table row has mounted.
    expect(queryByText("orders")).toBeNull();
  });

  test("clicking the connection header expands the table list", () => {
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection(),
        onColumnAnchor: () => {},
        disabled: false,
      }),
    );
    expect(queryByText("orders")).toBeNull();
    fireEvent.click(getByText("conn_1"));
    expect(getByText("orders")).toBeDefined();
  });

  test("an active filter force-expands a collapsed section", () => {
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection(),
        onColumnAnchor: () => {},
        disabled: false,
        query: "ord",
      }),
    );
    // No header click — the search alone surfaces the matching row.
    expect(getByText("orders")).toBeDefined();
  });
});

describe("ConnectionCoverageSection — search + state filters (#4652)", () => {
  test("the query narrows to matching tables and reports the match count", () => {
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connectionWithTables([
          table({ table: "orders" }),
          // The fixture's default entity is "orders" — override it so this
          // table matches neither by name nor by entity.
          table({ table: "customers", entity: "customers" }),
        ]),
        onColumnAnchor: () => {},
        disabled: false,
        defaultOpen: true,
        query: "ord",
      }),
    );
    expect(getByText("orders")).toBeDefined();
    expect(queryByText("customers")).toBeNull();
    expect(getByText(/1 match/)).toBeDefined();
  });

  test("the query also matches on the modeling entity name", () => {
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connectionWithTables([
          table({ table: "ord_hdr", entity: "orders" }),
          table({ table: "customers", entity: "customers" }),
        ]),
        onColumnAnchor: () => {},
        disabled: false,
        defaultOpen: true,
        query: "orders",
      }),
    );
    expect(getByText("ord_hdr")).toBeDefined();
    expect(queryByText("customers")).toBeNull();
  });

  test("the state filter narrows to that coverage state", () => {
    const stateFilter: TableCoverageState = "uncovered";
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connectionWithTables([
          table({ table: "orders", state: "partial" }),
          table({ table: "audit_log", entity: null, state: "uncovered" }),
        ]),
        onColumnAnchor: () => {},
        disabled: false,
        defaultOpen: true,
        stateFilter,
      }),
    );
    expect(getByText("audit_log")).toBeDefined();
    expect(queryByText("orders")).toBeNull();
  });

  test("a filter with no matches renders the no-match line, not an empty void", () => {
    const { getByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connection(),
        onColumnAnchor: () => {},
        disabled: false,
        defaultOpen: true,
        query: "zzz_nothing",
      }),
    );
    expect(getByText(/No tables match the current filter/i)).toBeDefined();
  });
});

describe("ConnectionCoverageSection — chunked rendering (#4652)", () => {
  const manyTables = Array.from({ length: COVERAGE_TABLE_PAGE_SIZE + 10 }, (_, i) =>
    table({ table: `t_${String(i).padStart(3, "0")}` }),
  );

  test("a long list mounts only the first page behind a Show more tail", () => {
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connectionWithTables(manyTables),
        onColumnAnchor: () => {},
        disabled: false,
        defaultOpen: true,
      }),
    );
    expect(getByText("t_000")).toBeDefined();
    expect(getByText(`t_${String(COVERAGE_TABLE_PAGE_SIZE - 1).padStart(3, "0")}`)).toBeDefined();
    // The first row past the page boundary has NOT mounted.
    expect(queryByText(`t_${String(COVERAGE_TABLE_PAGE_SIZE).padStart(3, "0")}`)).toBeNull();
    expect(getByText(/Show 10 more/)).toBeDefined();
  });

  test("Show more mounts the next chunk", () => {
    const { getByText, queryByText } = render(
      createElement(ConnectionCoverageSection, {
        connection: connectionWithTables(manyTables),
        onColumnAnchor: () => {},
        disabled: false,
        defaultOpen: true,
      }),
    );
    fireEvent.click(getByText(/Show 10 more/));
    expect(getByText(`t_${String(COVERAGE_TABLE_PAGE_SIZE + 9).padStart(3, "0")}`)).toBeDefined();
    // Everything mounted — the tail is gone.
    expect(queryByText(/Show .* more/)).toBeNull();
  });
});

describe("CoverageFilterBar (#4652)", () => {
  test("typing fires onQueryChange; a state chip fires onStateFilterChange", () => {
    const onQueryChange = mock((_q: string) => {});
    const onStateFilterChange = mock((_s: TableCoverageState | null) => {});
    const { getByLabelText, getByText } = render(
      createElement(CoverageFilterBar, {
        query: "",
        onQueryChange,
        stateFilter: null,
        onStateFilterChange,
      }),
    );
    fireEvent.change(getByLabelText("Filter tables by name"), { target: { value: "ord" } });
    expect(onQueryChange).toHaveBeenCalledWith("ord");
    fireEvent.click(getByText("uncovered"));
    expect(onStateFilterChange).toHaveBeenCalledWith("uncovered");
  });

  test("clicking the active state chip clears the filter back to all", () => {
    const onStateFilterChange = mock((_s: TableCoverageState | null) => {});
    const { getByText } = render(
      createElement(CoverageFilterBar, {
        query: "",
        onQueryChange: () => {},
        stateFilter: "uncovered",
        onStateFilterChange,
      }),
    );
    fireEvent.click(getByText("uncovered"));
    expect(onStateFilterChange).toHaveBeenCalledWith(null);
  });
});
