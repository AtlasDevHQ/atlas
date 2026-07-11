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
 * The presentational components are rendered directly (no fetch), mirroring the
 * launchers suite that renders `AnchorLaunchers` / `ActiveAnchorChip` directly.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  ConnectionCoverageSection,
  type ColumnAnchorRequest,
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
      createElement(ConnectionCoverageSection, { connection: flat, onColumnAnchor, disabled: false }),
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
      createElement(ConnectionCoverageSection, { connection: ready, onColumnAnchor: () => {}, disabled: false }),
    );
    // Summary chips reflect the three states (AC1).
    expect(getByText("3 covered")).toBeDefined();
    expect(getByText("2 partial")).toBeDefined();
    expect(getByText("1 uncovered")).toBeDefined();
    // The table's own covered badge renders.
    expect(getByText("covered")).toBeDefined();
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
      createElement(ConnectionCoverageSection, { connection: uncovered, onColumnAnchor: () => {}, disabled: false }),
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
