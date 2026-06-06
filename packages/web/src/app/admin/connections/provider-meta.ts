import {
  Cloud,
  Database,
  HardDrive,
  Snowflake,
  type LucideIcon,
} from "lucide-react";
import { DB_TYPES } from "@/ui/lib/types";

/* ────────────────────────────────────────────────────────────────────────
 *  Provider metadata — shared by the connections page (rendering connected
 *  databases) and the Add-connection picker (offering providers to connect).
 *  Single source so an icon / blurb never drifts between the two surfaces.
 * ──────────────────────────────────────────────────────────────────────── */

/** SQL database providers offered in the Add picker, in display order.
 *  Salesforce is intentionally excluded — it installs via OAuth from its own
 *  "Apps & CRM" section, not the URL-form connection dialog. */
export const DATABASE_PROVIDERS: ReadonlyArray<{ value: string; label: string }> =
  DB_TYPES.filter((t) => t.value !== "salesforce");

/** Map a dbType to the icon used in rows and picker tiles. */
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
    default:
      return "Datasource connection";
  }
}

export function labelForDbType(dbType: string): string {
  return DB_TYPES.find((t) => t.value === dbType)?.label ?? dbType;
}
