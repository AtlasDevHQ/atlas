import type { ToolSet } from "ai";
import { type AtlasAction, isAction } from "@atlas/api/lib/action-types";
import { explore } from "./explore";
import { executeSQL } from "./sql";
import {
  createDashboard,
  makeCreateDashboardTool,
  WORKSPACE_DASHBOARD_URL_RESOLVER,
  type DashboardUrlResolver,
} from "./create-dashboard";
import { sendEmailTool, SEND_EMAIL_DESCRIPTION } from "@atlas/api/lib/integrations/email-tool";
import {
  createLinearIssueTool,
  CREATE_LINEAR_ISSUE_DESCRIPTION,
} from "@atlas/api/lib/integrations/linear-tool";
import {
  querySalesforceTool,
  QUERY_SALESFORCE_DESCRIPTION,
  isSalesforceOAuthConfigured,
} from "@atlas/api/lib/integrations/salesforce-tool";
import { searchKnowledge, SEARCH_KNOWLEDGE_DESCRIPTION } from "./search-knowledge";
import { withToolSpans } from "./tool-spans";

export type { AtlasAction, DashboardUrlResolver };
export { isAction, WORKSPACE_DASHBOARD_URL_RESOLVER };

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

  /**
   * The executable tool set handed to the agent — every entry wrapped in an
   * `atlas.tool.<name>` span (#4464). This is where tools leave the registry
   * for the AI SDK, so instrumenting here (rather than per tool) means a newly
   * registered tool is traced by construction. `get()` / `entries()`
   * deliberately return the RAW entries: they feed metadata and `merge()`, and
   * re-registering a wrapped tool would nest a redundant span.
   *
   * The wrappers are minted per call, so the returned tools are NOT
   * identity-stable across calls — callers that only need names (`config.ts`)
   * are unaffected; callers that compare tool identity should use `entries()`.
   * The span's known boundaries (plugin hook dispatch sits outside it; a
   * hook-rejected call emits none) are documented in
   * `docs/development/telemetry.md`.
   */
  getAll(): ToolSet {
    const result: ToolSet = {};
    for (const [name, entry] of this.tools) {
      result[name] = entry.tool;
    }
    return withToolSpans(result);
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
   * Names registered in BOTH `base` and `overlay`. Under {@link merge} the
   * base entry wins, so each of these overlay entries is shadowed — it will
   * never be invoked. Pure helper; the caller surfaces the conflict (boot-time
   * operator warning in `api/server.ts`, #3326).
   */
  static shadowedNames(base: ToolRegistry, overlay: ToolRegistry): string[] {
    const shadowed: string[] = [];
    for (const [name] of overlay.entries()) {
      if (base.get(name)) shadowed.push(name);
    }
    return shadowed;
  }

  /**
   * Create a new registry by merging one or more registries on top of a base.
   * The BASE takes precedence: a name already present is not overwritten (see
   * {@link shadowedNames}, which surfaces exactly those shadowed overlay
   * entries). The returned registry is
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

// --- Workflow descriptions ---

export const EXPLORE_DESCRIPTION = `### 2. Explore the Semantic Layer
Use the explore tool to run bash commands against the semantic/ directory:
- Start with \`cat catalog.yml\` to find relevant entities
- Read entity schemas: \`cat entities/companies.yml\`, \`head -30 entities/deals.yml\`
- Search across files: \`grep -r "revenue" entities/\`, \`grep -rl "join" entities/\`
- List and discover files: \`ls entities/\`, \`find . -name "*.yml"\`, \`tree\`
- Check metrics/*.yml for canonical metric definitions — use these SQL patterns exactly
- Combine commands with pipes: \`grep -r "column" entities/ | sort\`, \`cat entities/deals.yml | grep -A5 "measures"\`
- Never guess column names. Always verify against the schema.`;

export const EXECUTE_SQL_DESCRIPTION = `### 3. Write and Execute SQL
Use the executeSQL tool to query the database:
- Use exact column names from the entity schemas
- If a canonical metric definition exists, use that SQL — do not improvise
- Include appropriate filters, groupings, and ordering
- If a query fails, read the error, fix the SQL, and retry (max 2 retries, never retry the same SQL)`;

const EXECUTE_PYTHON_DESCRIPTION = `### 4. Analyze Data with Python
Use the executePython tool for analysis that SQL alone cannot handle:
- Statistical analysis (correlations, regressions, hypothesis tests)
- Data transformations (pivoting, reshaping, time series decomposition)
- Visualizations and advanced charts

**Always run executeSQL first**, then pass results to executePython via the \`data\` parameter.

**Output modes:**
- \`_atlas_table\` — structured table results (columns + rows)
- \`_atlas_chart\` — interactive Recharts chart (preferred for bar/line/pie)
- \`chart_path(n)\` — matplotlib PNG (use for heatmaps, scatter matrices, violin plots)
- \`print()\` — narrative text output

Do NOT use executePython for simple aggregations, GROUP BY, or filtering — executeSQL handles those.`;

export const CREATE_DASHBOARD_DESCRIPTION = `### Create a Dashboard
Use the createDashboard tool when the user wants a dashboard, not just a single chart:
- Call AFTER executeSQL has confirmed each card's column names — chartConfig.categoryColumn and valueColumns must match the SQL output
- Each card needs: title, sql, chartConfig ({ type, categoryColumn, valueColumns })
- chart types: bar, line, pie, area, scatter, table
- Layout is optional — omit it and the dashboard auto-arranges
- The tool COMMITS a real dashboard owned by the calling user and stages the initial cards in the user's draft (not yet visible to other org members). The chat surfaces a "Continue editing on the dashboard" link to the new id; the same conversation resumes there in bound mode for further edits
- If any card has invalid SQL the whole call is rejected — fix the failing card and call again with the full set`;

// --- Core tool registration ---

/**
 * Register the always-on core tools into `registry`. Shared by every registry
 * builder (`defaultRegistry`, `nonDashboardRegistry`, `buildRegistry`) so the
 * core set is stated exactly once.
 *
 * `createDashboard` is surface-gated (#4566): a non-null `dashboardUrlResolver`
 * registers it bound to that resolver's handoff route; `null` omits it because
 * the surface owns no dashboards route and a handoff link would be unreachable.
 * The other core tools are registered unconditionally and gated at execute time
 * (workspace/install/context checks inside `execute`) — except `querySalesforce`,
 * which is additionally env-gated on the Salesforce OAuth config (see its inline
 * note below).
 */
function registerCoreTools(
  registry: ToolRegistry,
  dashboardUrlResolver: DashboardUrlResolver | null,
): void {
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

  // #4566 — surface-gated. A resolver means this surface owns a dashboards
  // route and can reach the handoff link; `null` means it can't, so the tool is
  // left out rather than handing the agent a dead-end draft. The workspace
  // resolver reuses the prebuilt singleton; a custom host resolver mints a
  // fresh instance bound to its route.
  if (dashboardUrlResolver) {
    registry.register({
      name: "createDashboard",
      description: CREATE_DASHBOARD_DESCRIPTION,
      tool:
        dashboardUrlResolver === WORKSPACE_DASHBOARD_URL_RESOLVER
          ? createDashboard
          : makeCreateDashboardTool(dashboardUrlResolver),
    });
  }

  // #4210 — layered knowledge-base search (frontmatter filter + Postgres FTS +
  // 1-hop graph expansion). Registered globally like the other execute-time-gated
  // tools: it reads the workspace + mode from request context inside execute — so
  // it stays discoverable everywhere without a boot-time gate. The two degraded
  // paths have deliberately different shapes: no active workspace returns an empty
  // result set (`{ results: [], neighbors: [] }`), while a deployment with no
  // internal DB returns a user-facing `{ error }`.
  registry.register({
    name: "searchKnowledge",
    description: SEARCH_KNOWLEDGE_DESCRIPTION,
    tool: searchKnowledge,
  });

  // First per-Workspace lazy-plugin tool (#2698). Registered globally
  // because the workspace + install check happens at execute time inside
  // the tool — keeping the tool discoverable across all Workspaces while
  // the "is the Email integration installed for this workspace" gate
  // runs in the loader.
  registry.register({
    name: "sendEmail",
    description: SEND_EMAIL_DESCRIPTION,
    tool: sendEmailTool,
  });

  // #2750 — Linear action target. Registered globally for the same reason
  // as `sendEmail` above: workspace + install check happens at execute
  // time, tool stays discoverable across all Workspaces, and the dual-
  // catalog (`catalog:linear` OAuth + `catalog:linear-apikey` form) dispatch
  // lives inside the tool's execute path.
  registry.register({
    name: "createLinearIssue",
    description: CREATE_LINEAR_ISSUE_DESCRIPTION,
    tool: createLinearIssueTool,
  });

  // #3311 — OAuth per-Workspace Salesforce query tool. Registered ONLY when the
  // Salesforce OAuth Connected App env is wired. The static-config `querySalesforce`
  // tool (`@useatlas/salesforce`, registered via the plugin context in self-host
  // static-url mode) needs a `salesforce://` url but NOT the OAuth env, so the two
  // modes don't normally coexist and this env gate keeps them apart.
  // KNOWN EDGE (#3326): if an operator sets BOTH a static url AND the OAuth env,
  // both register name `querySalesforce`; `ToolRegistry.merge(base, plugin)` gives
  // this base entry precedence, so the OAuth tool shadows the static one (and in
  // single-tenant self-host returns `no_workspace` on every call). The expected
  // deployments are mutually exclusive, so the conflict is surfaced — not
  // resolved: `api/server.ts` detects it at boot via `ToolRegistry.shadowedNames`
  // and logs an operator-facing error naming the remediation. Like sendEmail /
  // createLinearIssue, the workspace + install gate runs at execute time.
  if (isSalesforceOAuthConfigured()) {
    registry.register({
      name: "querySalesforce",
      description: QUERY_SALESFORCE_DESCRIPTION,
      tool: querySalesforceTool,
    });
  }
}

// --- Default registry ---
// The workspace surface (self-hosted single-tenant + SaaS web) — it owns
// `/dashboards/[id]`, so `createDashboard` registers with the workspace resolver.

const defaultRegistry = new ToolRegistry();
registerCoreTools(defaultRegistry, WORKSPACE_DASHBOARD_URL_RESOLVER);
defaultRegistry.freeze();

// --- Non-dashboard registry (#4566) ---
// Core tools MINUS createDashboard, for surfaces that own no dashboards route
// (SDK / Slack / MCP / scheduler via `executeAgentQuery`). Also the
// guaranteed-safe fallback when `buildRegistry` throws — so the createDashboard
// omission holds even on the error path instead of falling through to the
// dashboards-owning `defaultRegistry`.
const nonDashboardRegistry = new ToolRegistry();
registerCoreTools(nonDashboardRegistry, null);
nonDashboardRegistry.freeze();

// ---------------------------------------------------------------------------
// Tool-name shadow policy (#3326)
//
// `api/server.ts` warns at boot when a plugin tool is shadowed by a core/action
// tool of the same name (`ToolRegistry.shadowedNames`). The per-name knowledge
// lives here, next to the registration sites, so the generic boot loop stays
// tool-agnostic.
// ---------------------------------------------------------------------------

/**
 * Known-INTENTIONAL overlaps — the same capability registered by two wiring
 * paths, where the core/action entry winning the merge is by design. The boot
 * warning skips these.
 *
 * - `sendEmailReport`: the operator-env action (`tools/actions/email.ts`) and
 *   the `plugins/email` Resend plugin both register this name with
 *   `actionType: "email:send"` — same Resend-backed report sender (see the
 *   coexistence note in `integrations/email-tool.ts`).
 */
export const INTENTIONAL_TOOL_SHADOWS: ReadonlySet<string> = new Set(["sendEmailReport"]);

/**
 * Operator remediation copy for known tool-name collisions, keyed by tool
 * name. Appended to the generic boot warning when the shadowed name matches.
 *
 * - `querySalesforce`: the static-url plugin tool vs the OAuth per-workspace
 *   tool (the KNOWN EDGE above) — the deployments are mutually exclusive.
 */
export const TOOL_SHADOW_REMEDIATIONS: Readonly<Record<string, string>> = {
  querySalesforce:
    "Unset SALESFORCE_CLIENT_ID/SALESFORCE_CLIENT_SECRET to use the static-url Salesforce tool, or remove the static salesforce:// datasource to use the OAuth per-workspace tool.",
};

interface BuildRegistryResult {
  registry: ToolRegistry;
  warnings: string[];
}

/**
 * Build a dynamic ToolRegistry with optional action and Python support.
 *
 * Python tool is included when `ATLAS_PYTHON_ENABLED=true`.
 * Action tools are included when `includeActions` is true.
 *
 * Returns both the registry and any warnings about tools that failed to load.
 * Fatal misconfigurations (e.g. Python enabled without sandbox URL) still throw.
 */
export async function buildRegistry(options?: {
  includeActions?: boolean;
  /**
   * Dashboard-URL resolver that gates `createDashboard` (#4566, PRD #4553 L2).
   * - `undefined` (default) → the built-in {@link WORKSPACE_DASHBOARD_URL_RESOLVER};
   *   the tool registers with the workspace `/dashboards/[id]` handoff, so
   *   every dashboards-owning surface keeps `createDashboard` unchanged.
   * - a custom resolver → the tool registers, and its handoff link points at
   *   the host's own dashboards route.
   * - `null` → the surface does NOT own a dashboards route; `createDashboard`
   *   is omitted entirely so the agent never proposes an unreachable draft
   *   (embed / SDK / Slack / scheduler).
   */
  dashboardUrlResolver?: DashboardUrlResolver | null;
}): Promise<BuildRegistryResult> {
  const registry = new ToolRegistry();
  const warnings: string[] = [];

  // #4566 — surface-gated createDashboard. Omitting the option means the
  // workspace default (dashboards-owning surface keeps the tool); `null` omits
  // it (the surface owns no dashboards route).
  const dashboardUrlResolver =
    options?.dashboardUrlResolver === undefined
      ? WORKSPACE_DASHBOARD_URL_RESOLVER
      : options.dashboardUrlResolver;
  registerCoreTools(registry, dashboardUrlResolver);

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
      warnings.push(
        "Action tools (JIRA, email) failed to load and are unavailable for this session. Inform the user and suggest they check server logs or retry later.",
      );
    }
  }

  registry.freeze();
  return { registry, warnings };
}

export { defaultRegistry, nonDashboardRegistry };
