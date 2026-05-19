/**
 * Public-dataset tool registry — adapter-side restriction for the
 * unlinked-asker proactive path (#2614).
 *
 * AC #2614 requires that when an unlinked Slack user reacts back on a
 * 🤖 to request the answer, the agent is restricted to the workspace's
 * `getPublicDataset` allowlist. The listener's post-filter
 * (`checkResultAgainstAllowlist`) is belt-and-braces — it strips a
 * non-public entity from the FINAL result — but the agent can still
 * READ rows from a sensitive entity (via `executeSQL`) or its YAML
 * shape (via `explore`) before that filter runs.
 *
 * This module produces a {@link ToolRegistry} that wraps the standard
 * `explore` + `executeSQL` tools with pre-execution allowlist gates:
 *
 *   - `executeSQL`: parses the SQL with {@link Parser.tableList} and
 *     rejects the call if any referenced table is not in
 *     `allowedEntities`. CTE names are intentionally NOT in the
 *     allowlist — the agent gets a clear error and can retry with a
 *     query against public-dataset entities only.
 *   - `explore`: scans the bash command for `entities/<name>.ya?ml`
 *     references via the same regex `collectProactiveResult` uses, and
 *     rejects if any extracted name is not in `allowedEntities`. Pure-
 *     navigation commands (`ls entities/`, `cat catalog.yml`,
 *     `grep -r foo .`) that don't pin a specific entity file pass
 *     through — the agent still needs to discover which entities exist.
 *
 * Rejections return a clear error STRING the agent can read and
 * recover from (same shape as the existing per-tool error returns:
 * `"Error: ..."`). This lets the agent reformulate against the
 * allowlist instead of hard-failing the whole turn.
 *
 * The allowlist is captured at registry construction time. The adapter
 * resolves `getPublicDataset` per request (admins can modify the
 * dataset between turns) and builds a fresh registry each call.
 */

import type { ToolSet } from "ai";
import { Parser } from "node-sql-parser";

import { createLogger } from "@atlas/api/lib/logger";
import { explore } from "@atlas/api/lib/tools/explore";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import {
  ToolRegistry,
  EXPLORE_DESCRIPTION,
  EXECUTE_SQL_DESCRIPTION,
} from "@atlas/api/lib/tools/registry";

const log = createLogger("proactive:public-dataset-tools");

// Reuse the same shape `collectProactiveResult` uses so admin-visible
// entity names and registry gating stay in lockstep.
const ENTITY_PATH_RE = /entities\/([A-Za-z0-9_\-./]+?)\.ya?ml/g;

// Shared parser instance — `node-sql-parser` is safe to reuse and the
// hot path here is "extract table names", not "validate dialect". We
// default to PostgreSQL grammar (matches the platform default); a
// table reference that confuses the PG parser falls through to the
// downstream `executeSQL` validator which auto-detects the right
// dialect and will reject anything malformed.
const parser = new Parser();

/**
 * Build a {@link ToolRegistry} restricted to the workspace's
 * public-dataset allowlist. Pass this through to `runAgent({ tools })`
 * for unlinked-asker proactive answers.
 *
 * @param allowedEntities  Entity names from {@link getPublicDataset}.
 *                         Order is irrelevant; comparison uses a Set.
 *                         Empty array means "block everything" — the
 *                         caller is expected to short-circuit before
 *                         constructing the registry when empty.
 */
export function createPublicDatasetToolRegistry(
  allowedEntities: ReadonlyArray<string>,
): ToolRegistry {
  const allowedSet = new Set(allowedEntities.map((e) => e.toLowerCase()));

  const wrappedExplore = wrapExplore(explore, allowedSet);
  const wrappedExecuteSQL = wrapExecuteSQL(executeSQL, allowedSet);

  const registry = new ToolRegistry();
  registry.register({
    name: "explore",
    description: EXPLORE_DESCRIPTION,
    tool: wrappedExplore,
  });
  registry.register({
    name: "executeSQL",
    description: EXECUTE_SQL_DESCRIPTION,
    tool: wrappedExecuteSQL,
  });
  registry.freeze();
  return registry;
}

// ---------------------------------------------------------------------------
// explore wrapper
// ---------------------------------------------------------------------------

function wrapExplore(
  base: typeof explore,
  allowedSet: ReadonlySet<string>,
): ToolSet[string] {
  const origExecute = base.execute;
  if (!origExecute) {
    // Defensive — the canonical explore tool always defines `execute`.
    // If a future refactor drops it, falling back to the original tool
    // would leave the gate disabled; throw instead so the regression is
    // surfaced loudly.
    throw new Error("explore tool is missing `execute` — cannot wrap for public-dataset gate");
  }

  // `execute` is wrapped, `inputSchema` is preserved from the base so
  // the agent's tool-call shape is unchanged. We deliberately don't
  // touch the description (the prompt teaches the agent the existing
  // syntax; the gate's error string steers it back when it strays).
  return {
    ...base,
    execute: async (
      args: { command: string },
      options: Parameters<NonNullable<typeof base.execute>>[1],
    ) => {
      const command = args.command;
      const refusal = checkExploreCommand(command, allowedSet);
      if (refusal !== null) {
        log.warn(
          { command: command.slice(0, 200), refusedEntity: refusal },
          "Explore command refused — entity not in public-dataset allowlist",
        );
        return `Error: Entity "${refusal}" is not available to unlinked askers — public dataset only. Try a command that references an entity in the workspace's curated allowlist, or omit the specific entity path (e.g. \`ls entities/\`).`;
      }
      return origExecute(args, options);
    },
  } as ToolSet[string];
}

/**
 * Scan an explore command for `entities/<name>.ya?ml` references.
 * Returns the FIRST entity name not in `allowedSet`, or `null` if
 * every reference is allowed (or the command references no entity
 * file at all — e.g. `ls entities/`, `cat catalog.yml`).
 *
 * Exported for unit tests so the gating logic can be exercised without
 * spinning up the bash backend.
 */
export function checkExploreCommand(
  command: string,
  allowedSet: ReadonlySet<string>,
): string | null {
  for (const match of command.matchAll(ENTITY_PATH_RE)) {
    const name = match[1].toLowerCase();
    if (!allowedSet.has(name)) {
      return match[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// executeSQL wrapper
// ---------------------------------------------------------------------------

function wrapExecuteSQL(
  base: typeof executeSQL,
  allowedSet: ReadonlySet<string>,
): ToolSet[string] {
  const origExecute = base.execute;
  if (!origExecute) {
    throw new Error("executeSQL tool is missing `execute` — cannot wrap for public-dataset gate");
  }

  return {
    ...base,
    execute: async (
      args: {
        sql: string;
        explanation: string;
        connectionId?: string;
        scope?: string;
      },
      options: Parameters<NonNullable<typeof base.execute>>[1],
    ) => {
      const refusal = checkExecuteSQL(args.sql, allowedSet);
      if (refusal !== null) {
        log.warn(
          { sqlPrefix: args.sql.slice(0, 200), refusedTable: refusal },
          "executeSQL refused — table not in public-dataset allowlist",
        );
        return {
          success: false,
          error: `Table "${refusal}" is not available to unlinked askers — public dataset only. Rewrite the query against an entity in the workspace's curated allowlist.`,
        };
      }
      return origExecute(args, options);
    },
  } as ToolSet[string];
}

/**
 * Parse the SQL and return the FIRST table name not in `allowedSet`,
 * or `null` if every referenced table is allowed (or extraction
 * failed). Extraction failure falls through to the downstream
 * `executeSQL` validator, which rejects unparseable SQL with a
 * clearer error than we could provide here.
 *
 * CTE names are excluded — a query like `WITH x AS (SELECT ...
 * FROM allowed_table) SELECT * FROM x` passes the gate as long as
 * `allowed_table` is in the allowlist. This matches the table-
 * whitelist semantics in `packages/api/src/lib/tools/sql.ts`.
 *
 * Exported for unit tests.
 */
export function checkExecuteSQL(
  sql: string,
  allowedSet: ReadonlySet<string>,
): string | null {
  let tables: string[];
  const cteNames = new Set<string>();
  try {
    const tableRefs = parser.tableList(sql, { database: "PostgresQL" });
    tables = tableRefs
      .map((ref) => {
        const parts = ref.split("::");
        return parts.pop()?.toLowerCase() ?? "";
      })
      .filter((t) => t);

    // Extract CTE names so they don't trip the allowlist gate.
    const ast = parser.astify(sql, { database: "PostgresQL" });
    const statements = Array.isArray(ast) ? ast : [ast];
    for (const stmt of statements) {
      const withClause = (stmt as { with?: unknown }).with;
      if (Array.isArray(withClause)) {
        for (const cte of withClause) {
          const name =
            (cte as { name?: { value?: string } | string })?.name &&
            typeof (cte as { name?: { value?: string } | string }).name === "object"
              ? ((cte as { name: { value?: string } }).name.value ?? "")
              : ((cte as { name?: string }).name ?? "");
          if (typeof name === "string" && name) {
            cteNames.add(name.toLowerCase());
          }
        }
      }
    }
  } catch (err) {
    log.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        sqlPrefix: sql.slice(0, 200),
      },
      "public-dataset SQL gate: parse failed — deferring to downstream validator",
    );
    return null;
  }

  for (const table of tables) {
    if (cteNames.has(table)) continue;
    if (!allowedSet.has(table)) {
      return table;
    }
  }
  return null;
}
