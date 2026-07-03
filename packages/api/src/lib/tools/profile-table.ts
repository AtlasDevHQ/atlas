/**
 * profileTable tool — column cardinality, null rates, and sample values for one
 * whitelisted table.
 *
 * Profiles through the ONE profiler home (#4197): the live connection resolved
 * by `resolveProfilingConnection` (riding the same `resolveLiveConnection` that
 * MCP and the wizard use), whose `profile()` is a capability bound to the creds
 * that built the connection. That makes the tool work for plugin dbTypes (ClickHouse,
 * Snowflake, BigQuery, …) and OAuth datasources, not just native pg/mysql — the
 * previous implementation hand-rolled its own registry-pool sampling queries and
 * was native-only. Subject to the same table whitelist + mode gate as executeSQL.
 */

import { tool } from "ai";
import { z } from "zod";
import { isConnectionVisibleInMode } from "@atlas/api/lib/db/connection";
import { getWhitelistedTables, getOrgWhitelistedTables } from "@atlas/api/lib/semantic";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";
import { resolveProfilingConnection } from "@atlas/api/lib/datasources/profiling-connection";

const log = createLogger("tool:profile-table");

/** One column's report — the unified `ColumnProfile`, mapped for the agent. */
export interface ProfileTableColumn {
  readonly name: string;
  readonly sqlType: string;
  readonly nullable: boolean;
  /** `null` when the profiler's column stats degraded (introspection failed). */
  readonly nullRate: number | null;
  readonly distinctCount: number | null;
  readonly sampleValues: string[];
  readonly isPrimaryKey: boolean;
  readonly isForeignKey: boolean;
  readonly isEnumLike: boolean;
}

export type ProfileTableResult =
  | { readonly error: string }
  | { readonly rowCount: number; readonly columns: ProfileTableColumn[] };

export const profileTable = tool({
  description: "Profile a table to get column cardinality, null rates, data types, and sample values. Only tables in the semantic layer can be profiled.",

  inputSchema: z.object({
    table: z.string().describe("Table name to profile"),
    columns: z
      .array(z.string())
      .optional()
      .describe("Specific columns to report (omit for all columns)"),
    connectionId: z
      .string()
      .optional()
      .describe("Target connection ID (omit for default)"),
  }),

  execute: async ({ table, columns, connectionId }) => {
    const connId = connectionId ?? "default";

    // Span the profileTable tool seam so a slow per-column profile is
    // attributable in traces (#3684). No-op when OTel is uninitialized (zero overhead).
    return withSpan(
      "atlas.profile.table",
      { "atlas.profile.table": table, "atlas.profile.connection_id": connId },
      () => profileTableImpl({ table, columns, connId }),
    );
  },
});

async function profileTableImpl({
  table,
  columns,
  connId,
}: {
  table: string;
  columns?: string[];
  connId: string;
}): Promise<ProfileTableResult> {
  try {
    // Whitelist + mode visibility check
    const reqCtx = getRequestContext();
    const atlasMode = reqCtx?.atlasMode ?? "published";
    const authOrgId = reqCtx?.user?.activeOrganizationId;

    // Mode isolation: reject non-visible connections before resolving a
    // connection. Mirrors the gate in executeSQL.
    if (authOrgId) {
      const visible = await isConnectionVisibleInMode(authOrgId, connId, atlasMode);
      if (!visible) {
        return {
          error: `Connection "${connId}" is not available in ${atlasMode} mode.`,
        };
      }
    }

    const whitelist = authOrgId
      ? getOrgWhitelistedTables(authOrgId, connId, atlasMode)
      : getWhitelistedTables(connId);

    if (!whitelist.has(table.toLowerCase())) {
      return {
        error: `Table "${table}" is not in the semantic layer whitelist. Only tables defined in entity YAML files can be profiled.`,
      };
    }

    // Resolve the live connection through the one profiler home. Introspection
    // is a capability of the connection — no dialect branching here.
    const resolved = await resolveProfilingConnection(connId, authOrgId);
    if (resolved.kind === "not_found") {
      return { error: `Connection "${connId}" was not found.` };
    }
    if (resolved.kind === "unsupported" || resolved.kind === "reconnect_required") {
      return { error: resolved.message };
    }

    const { connection } = resolved;
    try {
      const result = await connection.profile({ selectedTables: [table] });

      const exact = result.profiles.find((p) => p.table_name === table);
      if (!exact && result.profiles[0]) {
        // A profiler that returns a profile under a different name (casing,
        // schema qualification) still profiled the ONE selected table — but
        // leave a breadcrumb so a mismatch is diagnosable, never silent.
        log.warn(
          { requested: table, got: result.profiles[0].table_name, connId },
          "profileTable: exact table_name match missed; using the positional profile",
        );
      }
      const profile = exact ?? result.profiles[0];
      if (!profile) {
        const profErr = result.errors.find((e) => e.table === table) ?? result.errors[0];
        log.warn(
          { table, connId, profilerError: profErr?.error },
          "profileTable: profiler returned no profile for table",
        );
        return {
          error: `Failed to profile table "${table}": ${
            profErr ? profErr.error : "table not found in the datasource"
          }`,
        };
      }

      const targetColumns = columns
        ? profile.columns.filter((c) => columns.includes(c.name))
        : profile.columns;

      return {
        rowCount: profile.row_count,
        columns: targetColumns.map((c) => ({
          name: c.name,
          sqlType: c.type,
          nullable: c.nullable,
          nullRate:
            c.null_count == null
              ? null
              : profile.row_count > 0
                ? c.null_count / profile.row_count
                : 0,
          distinctCount: c.unique_count,
          sampleValues: c.sample_values,
          isPrimaryKey: c.is_primary_key,
          isForeignKey: c.is_foreign_key,
          isEnumLike: c.is_enum_like,
        })),
      };
    } finally {
      // The caller owns the resolved connection's lifecycle — a plugin-built
      // connection is a real client that must be torn down. Best-effort: a
      // close failure must not mask the profile result.
      await connection.close().catch((closeErr: unknown) => {
        log.warn(
          { err: closeErr instanceof Error ? closeErr.message : String(closeErr), table, connId },
          "Failed to close profiling connection",
        );
      });
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), table, connId },
      "profileTable failed",
    );
    return {
      error: `Failed to profile table "${table}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
