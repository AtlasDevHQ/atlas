/**
 * Dialect specialists — the named registry of engine-specific SQL expertise
 * (#4515, PRD #4502; CONTEXT.md § Dialect specialist).
 *
 * A dialect specialist is engine-specific know-how (Postgres, MySQL,
 * ClickHouse, …) as a composable prompt MODULE keyed by `dbType` — shaped like
 * the answer-styles registry (`lib/answer-styles.ts`), not like a separate
 * per-engine agent. "One agent, composed prompt": the specialist module knows
 * the engine; the expert persona (`lib/semantic/expert/persona.ts`) owns the
 * semantic layer and Amendments; the analyst role owns the answer. At
 * conversation assembly the modules for the groups in scope compose into the
 * one agent's prompt — a cross-group sweep composes several, each attributed to
 * its group ({@link composeDialectSpecialists}). The wizard enrich pass reuses
 * the same modules so its LLM call is engine-aware too.
 *
 * Two module sources, resolved by {@link resolveDialectSpecialist}:
 *
 * - **Core** ships the initial Postgres / MySQL / ClickHouse modules
 *   ({@link CORE_DIALECT_SPECIALISTS}). Postgres is the dialect the base agent
 *   guidance is already written in, so its module is a short orientation; the
 *   others are framed as "differences from PostgreSQL".
 * - **Plugins** ship a module alongside their datasource capability via the
 *   existing `dialect` field on `AtlasDatasourcePlugin` (projected into
 *   {@link PluginDialectModule} by `pluginDialectModules()` in
 *   `lib/plugins/tools.ts`, which wraps `getDialectHints()`), so a plugin adds
 *   engine expertise for a new `dbType` with **no core change**. A plugin
 *   module for a `dbType` takes precedence over the core module for that same
 *   `dbType` — the plugin owns its engine and may carry richer, version-pinned
 *   guidance than the core baseline.
 *
 * Unlike the answer-style registry, resolution is TOTAL-with-a-gap rather than
 * total: an unknown `dbType` (no core module, no plugin module) resolves to
 * `undefined` and composes cleanly as no module — a datasource the agent can
 * still query with standard SQL, just without engine-specific coaching. This
 * registry lives in core (never `/ee`) and reads no env vars.
 */

/**
 * Display names for known engines — the source of truth for how a `dbType` is
 * spelled in a specialist heading, in the agent's multi-source listing
 * (`buildMultiSourceSection` calls {@link dialectDisplayName} directly), and in
 * the wizard enrich pass's "valid <dialect> SQL" instruction. Unknown / plugin
 * `dbType`s fall through to a capitalize fallback in {@link dialectDisplayName}.
 */
const DIALECT_DISPLAY_NAMES: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  clickhouse: "ClickHouse",
  snowflake: "Snowflake",
  duckdb: "DuckDB",
  bigquery: "BigQuery",
  salesforce: "Salesforce SOQL",
  elasticsearch: "Elasticsearch",
  opensearch: "OpenSearch",
};

/**
 * Human display name for a `dbType`. Known engines use their canonical spelling
 * ({@link DIALECT_DISPLAY_NAMES}); anything else (a plugin's custom `dbType`)
 * is capitalized as a best-effort fallback.
 */
export function dialectDisplayName(dbType: string): string {
  return (
    DIALECT_DISPLAY_NAMES[dbType] ??
    (dbType ? dbType.charAt(0).toUpperCase() + dbType.slice(1) : dbType)
  );
}

const POSTGRES_MODULE = `This datasource uses PostgreSQL — the dialect the standard SQL guidance above is written in, so the default patterns apply directly.
- Truncate/extract dates with \`DATE_TRUNC('month', col)\`, \`EXTRACT(YEAR FROM col)\`, or \`TO_CHAR(col, 'YYYY-MM')\`.
- Cast with \`col::type\` or \`CAST(col AS type)\`; use \`ILIKE\` for case-insensitive matching.
- Aggregate text with \`STRING_AGG(col, ', ')\`; concatenate with \`||\`.
- Use \`FILTER (WHERE ...)\` on aggregates, and \`COALESCE\` / \`NULLIF\` for null handling.`;

// Verbatim body of the pre-#4515 `MYSQL_DIALECT_GUIDE` (agent.ts), minus its
// own heading — {@link composeDialectSpecialists} generates the
// `## SQL Dialect: MySQL` heading so the assembled text is unchanged.
const MYSQL_MODULE = `This database uses MySQL. Key differences from PostgreSQL:
- For **projecting or grouping** by a date part, use \`YEAR(col)\` / \`MONTH(col)\` (or \`EXTRACT(YEAR FROM col)\`) and \`DATE_FORMAT(col, '%Y-%m')\` (instead of \`TO_CHAR(col, 'YYYY-MM')\`) — e.g. \`SELECT DATE_FORMAT(created_at, '%Y-%m') AS month ... GROUP BY 1\`
- For **filtering** an indexed date column, do NOT wrap it: \`WHERE YEAR(col) = 2024\` or \`WHERE DATE_FORMAT(col, '%Y-%m') = '2024-03'\` forces a full table scan. Use a half-open range on the bare column instead — \`WHERE col >= '2024-01-01' AND col < '2025-01-01'\` (year) or \`WHERE col >= '2024-03-01' AND col < '2024-04-01'\` (month). See the Sargability rules above
- Use \`IFNULL(col, default)\` or \`COALESCE(col, default)\` — both work
- Use backtick quoting for identifiers: \`\\\`column\\\`\` instead of \`"column"\`
- Use \`CONCAT(a, b)\` for string concatenation — \`||\` is logical OR in MySQL
- No \`ILIKE\` — use \`WHERE col COLLATE utf8mb4_bin LIKE 'pattern'\` for case-sensitive matching
- \`GROUP_CONCAT(col SEPARATOR ', ')\` instead of \`STRING_AGG(col, ', ')\`
- No \`::type\` casting — use \`CAST(x AS SIGNED)\`, \`CAST(x AS DECIMAL)\`
- \`LIMIT offset, count\` or \`LIMIT count OFFSET offset\` — both forms work
- \`COALESCE\`, \`CASE\`, \`NULLIF\`, \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\` work identically`;

const CLICKHOUSE_MODULE = `This datasource uses the ClickHouse SQL dialect. Key differences from PostgreSQL:
- Truncate dates with \`toStartOfMonth(col)\` / \`toStartOfWeek(col)\` / \`toStartOfDay(col)\` (not \`DATE_TRUNC\`).
- Use \`countIf(condition)\` instead of \`COUNT(CASE WHEN ... END)\`, and \`sumIf(column, condition)\` instead of \`SUM(CASE WHEN ... END)\`.
- Unnest arrays with \`arrayJoin()\`; split strings with \`splitByChar()\`.
- String functions: \`lower()\`, \`upper()\`, \`trim()\`.
- Do not add \`FORMAT\` clauses — the adapter handles output format automatically.
- ClickHouse is column-oriented — avoid \`SELECT *\` on wide tables; project only the columns you need.`;

/** The `dbType`s core ships a specialist for, in display order. */
export const CORE_DIALECT_SPECIALIST_DBTYPES = [
  "postgres",
  "mysql",
  "clickhouse",
] as const;

/** A `dbType` core ships a specialist module for. */
export type CoreDialectDbType = (typeof CORE_DIALECT_SPECIALIST_DBTYPES)[number];

/**
 * The core-shipped dialect specialist modules, keyed by `dbType`. Bodies carry
 * NO heading — {@link composeDialectSpecialists} generates
 * `## SQL Dialect: <name>` so single- and multi-group prompts render
 * consistently.
 *
 * Keyed by {@link CoreDialectDbType} (derived from
 * {@link CORE_DIALECT_SPECIALIST_DBTYPES}) so the Record's keys and the tuple
 * can never drift — adding a module without listing its dbType (or vice versa)
 * fails to compile, mirroring `answer-styles.ts`'s `ANSWER_STYLE_ADDENDA`.
 */
export const CORE_DIALECT_SPECIALISTS: Readonly<Record<CoreDialectDbType, string>> = {
  postgres: POSTGRES_MODULE,
  mysql: MYSQL_MODULE,
  clickhouse: CLICKHOUSE_MODULE,
};

/**
 * A plugin-shipped dialect module, keyed by the engine it describes. Sourced
 * from a datasource plugin's `dialect` field (collected as a `DialectHint` at
 * wiring time; see `lib/plugins/wiring.ts`), so shipping engine expertise for a
 * new `dbType` needs no core change.
 */
export interface PluginDialectModule {
  readonly dbType: string;
  readonly module: string;
}

/** Where a resolved specialist module came from. */
export type DialectSpecialistSource = "core" | "plugin";

/** A resolved dialect specialist for one `dbType`. */
export interface ResolvedDialectSpecialist {
  readonly dbType: string;
  readonly source: DialectSpecialistSource;
  /** The module body (no heading). */
  readonly module: string;
}

/**
 * Resolve the dialect specialist module for a `dbType`. A plugin module for the
 * `dbType` wins over the core module (the plugin owns its engine); falling back
 * to the core module; `undefined` when neither exists (an unknown engine, which
 * {@link composeDialectSpecialists} then contributes as no module).
 *
 * A plugin module with a blank/whitespace-only body is ignored, so a plugin
 * that declares `dialect: ""` doesn't shadow the core module with nothing.
 */
export function resolveDialectSpecialist(
  dbType: string,
  pluginModules: readonly PluginDialectModule[] = [],
): ResolvedDialectSpecialist | undefined {
  const pluginMatch = pluginModules.find(
    (m) => m.dbType === dbType && m.module.trim().length > 0,
  );
  if (pluginMatch) {
    return { dbType, source: "plugin", module: pluginMatch.module };
  }
  // `dbType` is the open engine string; narrow to a core key via `Object.hasOwn`
  // before indexing the tuple-keyed Record (no unsafe cast).
  if (Object.hasOwn(CORE_DIALECT_SPECIALISTS, dbType)) {
    return {
      dbType,
      source: "core",
      module: CORE_DIALECT_SPECIALISTS[dbType as CoreDialectDbType],
    };
  }
  return undefined;
}

/** A connection group in scope, paired with the engine it runs on. */
export interface DialectSpecialistGroup {
  /** Connection group id (a group-of-one uses its connection id — #3855). */
  readonly group: string;
  readonly dbType: string;
}

/**
 * Compose the dialect specialist section for the groups in scope.
 *
 * Groups are folded by `dbType` — a cross-group sweep with two Postgres groups
 * and one ClickHouse group composes the Postgres module ONCE (attributed to
 * both groups) and the ClickHouse module once, not the same module per member.
 * Distinct engines appear in first-seen group order. A group whose `dbType`
 * resolves to no module ({@link resolveDialectSpecialist} → `undefined`) is
 * skipped — an unknown engine composes cleanly as nothing.
 *
 * Rendering:
 * - each engine renders as `## SQL Dialect: <name>` + its module body, so a
 *   single-engine workspace's output is heading-identical to the pre-#4515
 *   inline dialect guide;
 * - when more than one group is in scope, each heading carries a
 *   `— group(s) \`a\`, \`b\`` attribution so the agent knows which source each
 *   module governs (the "each attributed to its group" contract).
 *
 * Returns `""` when nothing in scope resolves to a module (the caller appends
 * nothing).
 */
export function composeDialectSpecialists(
  groups: readonly DialectSpecialistGroup[],
  pluginModules: readonly PluginDialectModule[] = [],
): string {
  // Fold groups → { dbType (first-seen order) → group ids }.
  const groupsByDbType = new Map<string, string[]>();
  for (const { group, dbType } of groups) {
    const list = groupsByDbType.get(dbType);
    if (list) {
      if (!list.includes(group)) list.push(group);
    } else {
      groupsByDbType.set(dbType, [group]);
    }
  }

  const multiGroup = groups.length > 1;
  const blocks: string[] = [];
  for (const [dbType, groupIds] of groupsByDbType) {
    const resolved = resolveDialectSpecialist(dbType, pluginModules);
    if (!resolved) continue;
    const name = dialectDisplayName(dbType);
    const attribution = multiGroup
      ? ` — group${groupIds.length > 1 ? "s" : ""} ${groupIds
          .map((g) => `\`${g}\``)
          .join(", ")}`
      : "";
    blocks.push(`## SQL Dialect: ${name}${attribution}\n${resolved.module}`);
  }

  return blocks.join("\n\n");
}
