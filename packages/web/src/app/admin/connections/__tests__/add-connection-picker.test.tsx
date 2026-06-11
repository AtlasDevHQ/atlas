/**
 * Add-connection picker routing coverage (#3377).
 *
 * The picker is the single entry point for connecting a datasource, and its
 * tile → install-path routing is exactly what the #3374 drift audit found
 * broken: ClickHouse / Snowflake / DuckDB tiles used to open the single-URL
 * dialog whose backend (`detectDBType`) rejects every non-pg/mysql scheme.
 * This file pins the corrected routing:
 *
 *   1. The URL-form group offers ONLY postgres + mysql (the two schemes the
 *      backend accepts).
 *   2. Plugin datasources render as catalog-driven form-install tiles fed by
 *      `GET /api/v1/integrations/catalog?pillar=datasource`, and picking one
 *      routes to the marketplace form-install (`onPickDatasourceForm`).
 *   3. Native / duplicated catalog slugs (postgres, mysql, demo-postgres,
 *      salesforce, openapi-generic, curated REST candidates) never render as
 *      form-install tiles.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// ── Hook mock ───────────────────────────────────────────────────────────────
//
// `useAdminFetch` is replaced wholesale: the test feeds already-parsed
// catalog entries (the post-transform `IntegrationsCatalogEntry` shape with
// the `access` union) and captures the requested path so the
// `?pillar=datasource` contract is pinned.

interface FetchState {
  data: { catalog: unknown[] } | null;
  loading: boolean;
}

let fetchState: FetchState = { data: null, loading: false };
let capturedPaths: string[] = [];

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (path: string) => {
    capturedPaths.push(path);
    return {
      data: fetchState.data,
      loading: fetchState.loading,
      error: null,
      setError: () => {},
      refetch: () => {},
    };
  },
  useInProgressSet: () => ({
    has: () => false,
    start: () => {},
    stop: () => {},
  }),
  friendlyError: (err: { message: string }) => err.message,
}));

import {
  AddConnectionPicker,
  type DatasourceFormCandidate,
} from "../add-connection-picker";
import { DATABASE_PROVIDERS } from "../provider-meta";

// ── Fixtures ────────────────────────────────────────────────────────────────

const CLICKHOUSE_SCHEMA = [
  { key: "url", type: "string", label: "Connection URL", required: true, secret: true },
  { key: "description", type: "string", label: "Description" },
];

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "catalog:clickhouse",
    slug: "clickhouse",
    type: "datasource",
    installModel: "form",
    name: "ClickHouse",
    description: "Connect a ClickHouse instance as an analytics datasource.",
    iconUrl: null,
    minPlan: "starter",
    configSchema: CLICKHOUSE_SCHEMA,
    installed: false,
    installedAt: null,
    installedBy: null,
    installStatus: null,
    upsellOnly: false,
    pillar: "datasource",
    implementationStatus: "available",
    installConfig: null,
    access: { kind: "accessible" },
    ...overrides,
  };
}

/** The full datasource-pillar listing a self-hosted deploy would return. */
function selfHostedCatalog() {
  return [
    makeEntry({ id: "catalog:postgres", slug: "postgres", name: "PostgreSQL" }),
    makeEntry({ id: "catalog:mysql", slug: "mysql", name: "MySQL" }),
    makeEntry(),
    makeEntry({ id: "catalog:snowflake", slug: "snowflake", name: "Snowflake" }),
    makeEntry({ id: "catalog:bigquery", slug: "bigquery", name: "BigQuery" }),
    makeEntry({ id: "catalog:duckdb", slug: "duckdb", name: "DuckDB" }),
    makeEntry({ id: "catalog:elasticsearch", slug: "elasticsearch", name: "Elasticsearch" }),
    makeEntry({ id: "catalog:demo-postgres", slug: "demo-postgres", name: "Demo Dataset" }),
    makeEntry({
      id: "catalog:salesforce",
      slug: "salesforce",
      name: "Salesforce",
      installModel: "oauth",
    }),
    makeEntry({ id: "catalog:openapi-generic", slug: "openapi-generic", name: "OpenAPI REST" }),
    makeEntry({ id: "catalog:stripe-data", slug: "stripe-data", name: "Stripe" }),
  ];
}

const noop = () => undefined;

function renderPicker(overrides: Partial<Parameters<typeof AddConnectionPicker>[0]> = {}) {
  return render(
    <AddConnectionPicker
      open
      onOpenChange={noop}
      demoReadOnly={false}
      onPickDatabase={noop}
      onPickCustomRest={noop}
      onPickCuratedForm={noop}
      onPickDatasourceForm={noop}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  fetchState = { data: { catalog: selfHostedCatalog() }, loading: false };
  capturedPaths = [];
});

afterEach(cleanup);

// ── Tests ───────────────────────────────────────────────────────────────────

describe("AddConnectionPicker — datasource tile routing (#3377)", () => {
  test("fetches the datasource-pillar catalog listing", () => {
    renderPicker();
    expect(capturedPaths).toContain("/api/v1/integrations/catalog?pillar=datasource");
  });

  test("URL-form group offers only postgres and mysql (the schemes the backend accepts)", () => {
    renderPicker();
    expect(DATABASE_PROVIDERS.map((p) => p.value)).toEqual(["postgres", "mysql"]);
    expect(screen.getByTestId("add-db-postgres")).toBeTruthy();
    expect(screen.getByTestId("add-db-mysql")).toBeTruthy();
    // The pre-#3377 dead-end tiles must NOT route into the URL form.
    for (const slug of ["clickhouse", "snowflake", "duckdb"]) {
      expect(screen.queryByTestId(`add-db-${slug}`)).toBeNull();
    }
  });

  test("plugin datasources render as catalog-driven form-install tiles", () => {
    renderPicker();
    for (const slug of ["clickhouse", "snowflake", "bigquery", "elasticsearch"]) {
      expect(screen.getByTestId(`add-ds-${slug}`)).toBeTruthy();
    }
  });

  test("native / duplicated catalog slugs never render as form-install tiles", () => {
    renderPicker();
    for (const slug of [
      "postgres",
      "mysql",
      "demo-postgres",
      "salesforce",
      "openapi-generic",
      "stripe-data",
    ]) {
      expect(screen.queryByTestId(`add-ds-${slug}`)).toBeNull();
    }
    // The curated candidate still renders — in its own "Popular APIs" group.
    expect(screen.getByTestId("add-curated-stripe-data")).toBeTruthy();
  });

  test("DuckDB renders only when the server returns it (SaaS filters it out server-side)", () => {
    // Self-hosted: the row is in the listing, so the tile shows.
    renderPicker();
    expect(screen.getByTestId("add-ds-duckdb")).toBeTruthy();
    cleanup();
    // SaaS: the server omits the `saas_eligible = false` row entirely
    // (#3301) — the picker renders no DuckDB surface at all.
    fetchState = {
      data: { catalog: selfHostedCatalog().filter((e) => e.slug !== "duckdb") },
      loading: false,
    };
    renderPicker();
    expect(screen.queryByTestId("add-ds-duckdb")).toBeNull();
    expect(screen.queryByTestId("add-db-duckdb")).toBeNull();
  });

  test("picking a form tile routes to the marketplace form-install and closes the picker", () => {
    const picked: DatasourceFormCandidate[] = [];
    const openChanges: boolean[] = [];
    renderPicker({
      onPickDatasourceForm: (candidate) => picked.push(candidate),
      onOpenChange: (open) => openChanges.push(open),
    });

    fireEvent.click(screen.getByTestId("add-ds-clickhouse"));

    expect(openChanges).toEqual([false]);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toEqual({
      slug: "clickhouse",
      name: "ClickHouse",
      description: "Connect a ClickHouse instance as an analytics datasource.",
      configSchema: CLICKHOUSE_SCHEMA,
    });
  });

  test("upgrade-gated and coming-soon tiles are disabled", () => {
    fetchState = {
      data: {
        catalog: [
          makeEntry({
            upsellOnly: true,
            access: { kind: "upgrade", requiredPlan: "business" },
          }),
          makeEntry({
            id: "catalog:snowflake",
            slug: "snowflake",
            name: "Snowflake",
            implementationStatus: "coming_soon",
          }),
        ],
      },
      loading: false,
    };
    renderPicker();
    expect((screen.getByTestId("add-ds-clickhouse") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("add-ds-snowflake") as HTMLButtonElement).disabled).toBe(true);
  });

  test("demo read-only disables the form-install tiles", () => {
    renderPicker({ demoReadOnly: true });
    expect((screen.getByTestId("add-ds-clickhouse") as HTMLButtonElement).disabled).toBe(true);
  });
});
