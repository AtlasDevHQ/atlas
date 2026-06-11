import {
  Cloud,
  Database,
  HardDrive,
  Search,
  Snowflake,
  type LucideIcon,
} from "lucide-react";
import { DB_TYPES, type DBType } from "@/ui/lib/types";

/* ────────────────────────────────────────────────────────────────────────
 *  Provider metadata — shared by the connections page (rendering connected
 *  databases) and the Add-connection picker (offering providers to connect).
 *  Single source so an icon / blurb never drifts between the two surfaces.
 *
 *  The lookup functions below take `dbType: string`, not the closed `DBType`
 *  union, on purpose: a *connected* row's dbType can be a plugin-/marketplace-
 *  registered datasource that isn't in the URL-form `DB_TYPES` dropdown (e.g.
 *  `bigquery`, seeded via the builtin-datasource catalog). So the extra switch
 *  arms + `default` fallback are load-bearing for those wider runtime values,
 *  and an exhaustiveness guard would wrongly reject them. The Add picker, by
 *  contrast, only ever offers `DATABASE_PROVIDERS` — which is genuinely `DBType`.
 * ──────────────────────────────────────────────────────────────────────── */

/** SQL database providers offered in the Add picker, in display order.
 *  Some `DB_TYPES` are intentionally excluded from the URL-form picker:
 *  - Salesforce installs via OAuth from its own "Apps & CRM" section.
 *  - Elasticsearch / OpenSearch install via a structured (url + apiKey) form,
 *    not the single-URL dialog — that admin install surface lands in #3270.
 *  - ClickHouse / Snowflake / DuckDB are plugin datasources: the URL-form
 *    backend (`POST /api/v1/admin/connections` → `detectDBType`) only accepts
 *    postgresql:// and mysql:// schemes, so a URL-form tile for them dead-ends
 *    with a 400 (#3377). They install via the catalog-driven form-install
 *    tiles the Add picker renders from `?pillar=datasource` instead.
 *  All still ship in `DB_TYPES` (wire/label union) so *connected* rows of
 *  those types render with the right label — they're just never offered
 *  through the single-URL dialog. */
const URL_FORM_EXCLUDED: ReadonlySet<DBType> = new Set([
  "salesforce",
  "elasticsearch",
  "opensearch",
  "clickhouse",
  "snowflake",
  "duckdb",
]);
export const DATABASE_PROVIDERS: ReadonlyArray<{ value: DBType; label: string }> =
  DB_TYPES.filter((t) => !URL_FORM_EXCLUDED.has(t.value));

/** Map a dbType to the icon used in rows and picker tiles. Accepts `string`
 *  (not `DBType`) to cover plugin-registered datasources — see file header. */
export function iconForDbType(dbType: string): LucideIcon {
  switch (dbType) {
    case "postgres":
    case "mysql":
    case "duckdb":
      return Database;
    case "snowflake":
      return Snowflake;
    case "clickhouse":
    case "bigquery":
      return Cloud;
    case "salesforce":
      return HardDrive;
    case "elasticsearch":
    case "opensearch":
      return Search;
    default:
      return Database;
  }
}

/** Human-friendly one-line description shown under a provider name. */
export function descriptionForDbType(dbType: string): string {
  switch (dbType) {
    case "postgres":
      return "Open-source OLTP — the default Atlas connection";
    case "mysql":
      return "MySQL / MariaDB OLTP instance";
    case "clickhouse":
      return "Column-store analytics warehouse";
    case "snowflake":
      return "Cloud data warehouse";
    case "duckdb":
      return "Embedded analytical SQL engine";
    case "salesforce":
      return "CRM objects via SOQL";
    case "bigquery":
      return "Google Cloud warehouse";
    case "elasticsearch":
      return "Search & log analytics cluster";
    case "opensearch":
      return "Open-source search & log analytics cluster";
    default:
      return "Datasource connection";
  }
}

export function labelForDbType(dbType: string): string {
  return DB_TYPES.find((t) => t.value === dbType)?.label ?? dbType;
}
