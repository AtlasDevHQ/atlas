/**
 * Tool registry for the Atlas agent.
 *
 * Decouples tool definitions from the agent loop so tool sets can be
 * composed dynamically. Each tool's {@link AtlasTool.description} is
 * injected into the agent's system prompt via {@link ToolRegistry.describe}.
 * The default registry contains the core tools (explore, executeSQL)
 * with their workflow descriptions extracted from the system prompt.
 */

import type { ToolSet } from "ai";
import { type AtlasAction, isAction } from "@atlas/api/lib/action-types";
import { explore } from "./explore";
import { executeSQL } from "./sql";

export type { AtlasAction };
export { isAction };

export interface AtlasTool {
  readonly name: string;
  /** Workflow guidance injected into the system prompt via describe(). */
  readonly description: string;
  readonly tool: ToolSet[string];
}

export class ToolRegistry {
  private tools = new Map<string, AtlasTool>();
  private frozen = false;

  register(entry: AtlasTool): void {
    if (this.frozen) {
      throw new Error("Cannot register tools on a frozen registry");
    }
    if (!entry.name.trim()) {
      throw new Error("Tool name must not be empty");
    }
    if (!entry.description.trim()) {
      throw new Error("Tool description must not be empty");
    }
    this.tools.set(entry.name, entry);
  }

  /** Freeze the registry, preventing further registrations. */
  freeze(): this {
    this.frozen = true;
    return this;
  }

  get(name: string): AtlasTool | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolSet {
    const result: ToolSet = {};
    for (const [name, entry] of this.tools) {
      result[name] = entry.tool;
    }
    return result;
  }

  /** Concatenate all tool descriptions. Output order follows registration order. */
  describe(): string {
    return Array.from(this.tools.values())
      .map((entry) => entry.description)
      .join("\n\n");
  }

  /** Iterate over all registered tool entries. */
  entries(): IterableIterator<[string, AtlasTool]> {
    return this.tools.entries();
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Create a new registry by merging one or more registries on top of a base.
   * Entries in later registries take precedence. The returned registry is
   * **unfrozen** — the caller should freeze it when ready.
   */
  static merge(base: ToolRegistry, ...others: ToolRegistry[]): ToolRegistry {
    const merged = new ToolRegistry();
    for (const [, entry] of base.entries()) {
      merged.register(entry);
    }
    for (const other of others) {
      for (const [name, entry] of other.entries()) {
        if (merged.get(name)) continue; // base takes precedence
        merged.register(entry);
      }
    }
    return merged;
  }

  /** Return all registered tools that are actions (have actionType metadata). */
  getActions(): AtlasAction[] {
    return Array.from(this.tools.values()).filter(isAction) as AtlasAction[];
  }

  /**
   * Check that all required credentials for registered actions are present
   * in the environment. Returns an array of `{ action, missing }` for each
   * action with missing credentials (empty array means all good).
   */
  validateActionCredentials(): { action: string; missing: string[] }[] {
    const results: { action: string; missing: string[] }[] = [];
    for (const action of this.getActions()) {
      const missing = action.requiredCredentials.filter(
        (key) => !process.env[key],
      );
      if (missing.length > 0) {
        results.push({ action: action.name, missing });
      }
    }
    return results;
  }
}

// --- Workflow descriptions (extracted from the system prompt) ---

const EXPLORE_DESCRIPTION = `### 2. Explore the Semantic Layer
Use the explore tool to run bash commands against the semantic/ directory:
- Start with \`cat catalog.yml\` to find relevant entities
- Read entity schemas: \`cat entities/companies.yml\`, \`head -30 entities/deals.yml\`
- Search across files: \`grep -r "revenue" entities/\`, \`grep -rl "join" entities/\`
- List and discover files: \`ls entities/\`, \`find . -name "*.yml"\`, \`tree\`
- Check metrics/*.yml for canonical metric definitions — use these SQL patterns exactly
- Combine commands with pipes: \`grep -r "column" entities/ | sort\`, \`cat entities/deals.yml | grep -A5 "measures"\`
- Never guess column names. Always verify against the schema.`;

const EXECUTE_SQL_DESCRIPTION = `### 3. Write and Execute SQL
Use the executeSQL tool to query the database:
- Use exact column names from the entity schemas
- If a canonical metric definition exists, use that SQL — do not improvise
- Include appropriate filters, groupings, and ordering
- If a query fails, read the error, fix the SQL, and retry (max 2 retries, never retry the same SQL)`;

const EXECUTE_PYTHON_DESCRIPTION = `### 4. Analyze Data with Python
Use the executePython tool for analysis that SQL alone cannot handle:
- Statistical analysis (correlations, regressions, distributions)
- Data transformations (pivoting, reshaping, time series resampling)
- Visualizations (charts saved to /tmp/chart_0.png, /tmp/chart_1.png, etc.)
- Pass SQL results as the data parameter to avoid re-querying
- Available libraries: pandas, numpy, matplotlib (if installed)
- Do NOT use executePython for simple queries — use executeSQL instead`;

// --- Default registry ---

const defaultRegistry = new ToolRegistry();

defaultRegistry.register({
  name: "explore",
  description: EXPLORE_DESCRIPTION,
  tool: explore,
});

defaultRegistry.register({
  name: "executeSQL",
  description: EXECUTE_SQL_DESCRIPTION,
  tool: executeSQL,
});

defaultRegistry.freeze();

/**
 * Build a dynamic ToolRegistry with optional action and Python support.
 *
 * Python tool is included when `ATLAS_PYTHON_ENABLED=true`.
 * Action tools are included when `includeActions` is true.
 */
export async function buildRegistry(options?: {
  includeActions?: boolean;
}): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  registry.register({
    name: "explore",
    description: EXPLORE_DESCRIPTION,
    tool: explore,
  });

  registry.register({
    name: "executeSQL",
    description: EXECUTE_SQL_DESCRIPTION,
    tool: executeSQL,
  });

  if (process.env.ATLAS_PYTHON_ENABLED === "true") {
    if (!process.env.ATLAS_SANDBOX_URL) {
      const { createLogger } = await import("@atlas/api/lib/logger");
      const pyLog = createLogger("registry");
      pyLog.error(
        "ATLAS_PYTHON_ENABLED=true but ATLAS_SANDBOX_URL is not set. " +
          "Python execution requires a sandbox sidecar for isolation.",
      );
      throw new Error(
        "ATLAS_PYTHON_ENABLED=true requires ATLAS_SANDBOX_URL to be set. " +
          "The Python tool runs in the sandbox sidecar for security isolation. " +
          "See deployment docs for sidecar setup.",
      );
    }

    try {
      const { executePython } = await import("./python");
      registry.register({
        name: "executePython",
        description: EXECUTE_PYTHON_DESCRIPTION,
        tool: executePython,
      });
    } catch (err) {
      const { createLogger } = await import("@atlas/api/lib/logger");
      const pyLog = createLogger("registry");
      pyLog.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to load Python tool — executePython will be unavailable",
      );
      throw err;
    }
  }

  if (options?.includeActions) {
    try {
      const { createJiraTicket, sendEmailReport } = await import("./actions");
      registry.register(createJiraTicket as unknown as AtlasTool);
      registry.register(sendEmailReport as unknown as AtlasTool);
    } catch (err) {
      const { createLogger } = await import("@atlas/api/lib/logger");
      const actionLog = createLogger("registry");
      actionLog.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to load action tools — JIRA and email actions will be unavailable",
      );
    }
  }

  registry.freeze();
  return registry;
}

export { defaultRegistry };
