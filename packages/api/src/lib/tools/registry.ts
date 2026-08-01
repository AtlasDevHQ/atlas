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
import { searchBrain, SEARCH_BRAIN_DESCRIPTION } from "./search-brain";
import { correctFactTool, CORRECT_FACT_DESCRIPTION } from "./correct-fact";
import { withToolSpans } from "./tool-spans";
import {
  isPythonSandboxMisconfigured,
  isPythonToolRequested,
  PYTHON_SANDBOX_MISCONFIGURED_MESSAGE,
} from "./python-sandbox-requirement";

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
 *
 * #4826 — that execute-time posture is a DELIBERATE choice for the SQL tools on
 * a workspace with no analytics datasource. Now that chat serves knowledge-only
 * and brain-only workspaces (see `lib/workspace-capability.ts`), `executeSQL`
 * can be offered to a workspace that has nothing to run it against. It stays
 * REGISTERED and fails per call: the pipeline raises `NoDatasourceConfiguredError`,
 * which `lib/tools/sql.ts` maps to a `NoDatasourceError` and then to a clean
 * `{ success: false, error }` tool result the agent can read and route around —
 * never an unhandled throw.
 *
 * De-registering it instead would make the surface vary **per workspace**. Note
 * what that does and does not cost: the surface already varies by *surface*
 * (`dashboardUrlResolver`) and by *process env* (`querySalesforce`,
 * `executePython`), both resolvable synchronously with no I/O. A per-workspace
 * surface is different in kind — it would mean threading a workspace id through
 * the builders and paying a DB probe on every turn to decide the tool list. It
 * would also strand the frozen singletons, which cannot express a per-workspace
 * answer at all and are still on live paths: the web chat route builds a
 * registry only when `ATLAS_ACTIONS_ENABLED=true` and otherwise rides
 * `defaultRegistry`, while `executeAgentQuery` (SDK / Slack / MCP / scheduler)
 * always builds but falls back to `nonDashboardRegistry`. That is a registry
 * refactor, not a release fix.
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

  // #4773 — the fused company-brain read (ADR-0036), which SUPERSEDES the
  // #4210 `searchKnowledge` registration: hosted documents are now one of three
  // stores (reviewed facts · raw episodes · documents), every result trust-tier
  // and provenance labeled. Registered globally like the other
  // execute-time-gated tools — it reads the workspace, mode, and principal set
  // from request context inside `execute`, so it stays discoverable everywhere
  // without a boot-time gate. Its four degraded paths each carry a
  // machine-readable `BrainToolReason` (see the header on `search-brain.ts`): no
  // internal DB, an unresolvable reader, and a failed search return a
  // user-facing `{ error }`; only "no active workspace" returns an empty result
  // set, and even that one is labelled `unavailable` rather than left bare.
  //
  // The old name is handled at the CONFIG seam, not here — see
  // {@link RENAMED_TOOLS}. Registering both spellings would hand the agent two
  // names for one capability.
  registry.register({
    name: "searchBrain",
    description: SEARCH_BRAIN_DESCRIPTION,
    tool: searchBrain,
  });

  // #4915 — the four correction verbs (ADR-0036 T4), core, under the ADR's
  // own spelling (`correct_fact`). Workspace, identity, and the owner/admin
  // authority gate all run at execute time inside the verb machinery — but
  // unlike `searchBrain` it is NOT registered globally, because it WRITES:
  // `nonDashboardRegistry` is the policy `POST /api/v1/query` reaches (via
  // `buildHeadlessRegistry()`; this singleton is that path's fallback), and
  // that operation is admitted to READ-SAFE Agent-Auth keys on a read-only-
  // engine guarantee (#4707, pinned by `agent-auth-read-safe-engine.test.ts`'s
  // tool-surface tripwire). A brain-mutating tool on that surface would break
  // the admission however well execute-time gating held. The dashboard-URL
  // resolver is the existing headless-vs-interactive signal (`null` = SDK /
  // Slack / MCP / scheduler via `executeAgentQuery`; non-null = a workspace
  // surface with a human in the loop), and today those classes coincide
  // exactly with where a correction verb belongs — if they ever diverge,
  // split the signal rather than re-globalizing this tool.
  //
  // #4936 — this gate only decides what each REGISTRY contains; the surface a
  // given turn actually gets is decided by which registry its `runAgent` call
  // site passes. That used to be a silent decision (`runAgent` defaulted to
  // the write-carrying `defaultRegistry`, so an omitted `tools` re-opened this
  // gate from the outside). The default now fails CLOSED to
  // `nonDashboardRegistry`, and `agent-runagent-call-sites.test.ts` pins the
  // registry each production call site must resolve to. This is the canonical
  // account of the GATE; each call site narrates only its own surface-specific
  // exposure rather than restating this.
  if (dashboardUrlResolver) {
    registry.register({
      name: "correct_fact",
      description: CORRECT_FACT_DESCRIPTION,
      tool: correctFactTool,
    });
  }

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
// Core tools MINUS createDashboard AND correct_fact (both gate on the same
// `dashboardUrlResolver` signal), for surfaces that own no dashboards route
// (SDK / Slack / MCP / scheduler via `executeAgentQuery`). Also the
// guaranteed-safe fallback when `buildRegistry` throws — so BOTH omissions hold
// even on the error path instead of falling through to the dashboards-owning
// `defaultRegistry`.
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
 * Tool names that were RENAMED, mapped old → new (#4773).
 *
 * Consumed by `validateToolConfig` only. The registry itself never registers an
 * old name: an agent-visible tool name carries no stability contract
 * (`shared/reference/stability.mdx`), and two names for one capability is a
 * worse tool surface than one.
 *
 * `atlas.config.ts` is a different contract. `validateToolConfig` THROWS on an
 * unknown name, so a self-hoster whose config listed `searchKnowledge` would
 * fail to BOOT on a patch upgrade — a rename inside Atlas turning into an
 * outage in someone else's deployment. So the old spelling is accepted at that
 * seam, normalized to the new one, and warned about once at startup.
 *
 * An entry is removed when the deprecation window closes, at which point the
 * old spelling goes back to being a boot-time `Unknown tool(s)` error naming
 * the available set.
 */
export const RENAMED_TOOLS: Readonly<Partial<Record<string, string>>> = {
  // #4773 — `searchKnowledge` became `searchBrain` when hosted documents
  // stopped being the whole tool and became one of three fused stores.
  searchKnowledge: "searchBrain",
};

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

/**
 * What every registry builder resolves to: the registry, plus the warnings the
 * MODEL is meant to relay. A warning here is user-facing copy, not an operator
 * log line — it is threaded into `runAgent({ warnings })`, which renders it
 * under `## Warnings` in the system prompt so the agent says "temporarily
 * unavailable, retry" instead of "I can't do that" (#4941).
 *
 * `buildHeadlessRegistry` returns the same shape, so both builders share one
 * type rather than growing a parallel headless-only one that can drift.
 * Exported because it is the return type of two exported functions — a consumer
 * that wants to name the result can otherwise only spell it as an
 * `Awaited<ReturnType<…>>` incantation that breaks on any signature change.
 *
 * `warnings` is `readonly` for a reason that is not stylistic: `runAgent`
 * treats its own `warnings` option as an in/out param and PUSHES into whatever
 * array it is handed (`agent.ts` adds semantic-layer and focus-datasource
 * warnings). A call site that wrote `warnings: registryWarnings` would hand it
 * this array; if a builder ever memoized its result, those pushes would
 * accumulate across turns and poison every later system prompt. `readonly`
 * makes the spread-copy at each call site the only thing that compiles, which
 * turns a comment into a compiler error.
 */
export interface BuildRegistryResult {
  readonly registry: ToolRegistry;
  readonly warnings: readonly string[];
}

/**
 * The one rule every degraded-tools warning has to end with, and the reason
 * these strings live here instead of at each surface.
 *
 * A registry that failed to build is still LESSER-PRIVILEGED, not stripped:
 * `registerCoreTools` gives `nonDashboardRegistry` and `defaultRegistry` alike
 * `sendEmail`, `createLinearIssue` and (when the OAuth env is wired)
 * `querySalesforce`, whatever else went wrong. So copy naming a whole category
 * — "action tools (JIRA, email) are unavailable" — hands the model a live
 * `sendEmail` while instructing it to tell the user email is down: the exact
 * wrong-explanation bug #4941 exists to fix, one capability over. Naming only
 * what was actually lost is necessary but not sufficient, because the model
 * generalizes; this says the quiet part outright.
 */
const NEVER_DISOWN_A_VISIBLE_TOOL =
  "Every tool you can see in your tool list works — do NOT tell the user that one of them is " +
  "unavailable. If the user asks for a capability you do not have, say it is temporarily " +
  "unavailable and suggest they retry or contact their Atlas administrator.";

/**
 * The warning for "the operator action tools did not load", authored by
 * {@link buildRegistry} and relayed by every surface that requested them.
 *
 * Names the two tools by their registry names rather than "JIRA and email":
 * `sendEmailReport` is gone, the core `sendEmail` is not, and the model has to
 * be able to tell them apart.
 */
export const ACTION_TOOLS_UNAVAILABLE_WARNING =
  "The operator action tools (createJiraTicket, sendEmailReport) failed to load and are " +
  "unavailable for this session. " +
  NEVER_DISOWN_A_VISIBLE_TOOL;

/**
 * The warning for "the registry build failed outright and the surface fell back
 * to a known-good set" — `nonDashboardRegistry` for the headless seam,
 * `defaultRegistry` for the two web chat paths. One function for all three so
 * three hand-maintained strings cannot drift into three policies, which is how
 * the first draft of this fix re-created the bug it was fixing.
 *
 * Relative to a build that SUCCEEDED, a fallback loses only what the env asked
 * for on top of the core set: the `tools/actions` operator pair under
 * `ATLAS_ACTIONS_ENABLED`, and `executePython` under `ATLAS_PYTHON_ENABLED`.
 * The copy is derived from exactly that, so a deployment that never enabled
 * either is never told it lost them.
 */
export function registryBuildFailedWarning(): string {
  const lost: string[] = [];
  if (process.env.ATLAS_ACTIONS_ENABLED === "true") {
    lost.push("the operator action tools (createJiraTicket, sendEmailReport)");
  }
  if (isPythonToolRequested()) {
    lost.push("Python execution (executePython)");
  }
  return (
    "A server configuration problem stopped the tool registry from building, so this session fell " +
    "back to a known-good tool set" +
    (lost.length > 0 ? `; ${lost.join(" and ")} did not load.` : ".") +
    " " +
    NEVER_DISOWN_A_VISIBLE_TOOL
  );
}

/**
 * Build a dynamic ToolRegistry with optional action and Python support.
 *
 * Python tool is included when `ATLAS_PYTHON_ENABLED=true`.
 * Action tools are included when `includeActions` is true.
 *
 * Returns both the registry and any warnings about tools that failed to load.
 * A degraded action-tool load is a warning; the two Python failure modes throw.
 *
 * #4940 — that throw is the BACKSTOP, not the contract. Every caller in the repo
 * catches it (startup's credential check, both chat-route sites, the Effect
 * tool-shadow check, `buildHeadlessRegistry`), which is correct at each seam —
 * the fallbacks preserve the isolation invariant by not carrying `executePython`
 * — but it used to mean nothing failed boot, so a misconfigured box ran
 * indefinitely with the tool silently absent. What makes the misconfiguration
 * genuinely fatal is `PythonSandboxGuardLive` (`lib/effect/saas-guards.ts`),
 * which fails the boot Layer on the same predicate before `api/server.ts` starts
 * listening. Both seams read it from `./python-sandbox-requirement` so they
 * cannot disagree. That guard covers the api server process, not every entry
 * point — `buildHeadlessRegistry` below enumerates what still reaches the throw.
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

  if (isPythonToolRequested()) {
    if (isPythonSandboxMisconfigured()) {
      // Reachable when the boot guard was relaxed (`ATLAS_DEPLOY_ENV=development`)
      // or never ran — the guard lives in the app Layer, which not every process
      // builds. See the enumeration on `buildHeadlessRegistry` below.
      const { createLogger } = await import("@atlas/api/lib/logger");
      const pyLog = createLogger("registry");
      pyLog.error(PYTHON_SANDBOX_MISCONFIGURED_MESSAGE);
      throw new Error(PYTHON_SANDBOX_MISCONFIGURED_MESSAGE);
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
      warnings.push(ACTION_TOOLS_UNAVAILABLE_WARNING);
    }
  }

  registry.freeze();
  return { registry, warnings };
}

/**
 * The registry for a HEADLESS agent surface — one that owns no dashboards
 * route and has no human in the loop (#4936).
 *
 * This is `executeAgentQuery`'s registry construction, lifted to a named seam
 * so the surfaces that re-enter the SAME turn rebuild from the SAME POLICY
 * (not necessarily the same SET — the env this seam and `buildRegistry` read
 * are re-read: `ATLAS_ACTIONS_ENABLED`, `ATLAS_PYTHON_ENABLED`, and the
 * Salesforce OAuth pair that gates `querySalesforce`). Chat
 * resume (`lib/chat-plugin/resume-turn.ts`) was the case that forced it: the
 * original Slack turn ran through `executeAgentQuery`, but the approval-resume
 * of that turn called `runAgent` with no `tools` at all — so the tool surface
 * silently widened across the resume boundary. Rebuilding it here keeps resume
 * faithful (an approved action tool is still executable) without either caller
 * re-deriving the policy.
 *
 * `dashboardUrlResolver: null` is the whole policy: it drops `createDashboard`
 * (a `/dashboards/[id]` handoff is unreachable from Slack or a scheduled
 * digest, #4566) and `correct_fact` (a brain-mutating write has no place on an
 * autonomous surface with no confirmation UI, #4915). Action tools stay opt-in
 * via `ATLAS_ACTIONS_ENABLED`.
 *
 * A build failure falls back to `nonDashboardRegistry`, NOT the dashboards-
 * owning `defaultRegistry`, so both omissions hold on the error path too.
 *
 * Returns {@link BuildRegistryResult}, not a bare registry (#4941). The bare
 * shape had nowhere for `warnings` to go, so a degraded action-tool load was
 * silently dropped on every headless surface and the model reported the
 * capability as ABSENT rather than temporarily unavailable — a wrong
 * explanation, not a missing one. Both callers thread the warnings into
 * `runAgent({ warnings })`, matching what `api/routes/chat.ts` already does for
 * the web surface. The fallback path below authors its own warning for the same
 * reason.
 *
 * This catch also covers `buildRegistry`'s DELIBERATE throws, and that is no
 * longer a swallowed contract (#4940). The Python-without-sandbox
 * misconfiguration fails the boot Layer in `PythonSandboxGuardLive`
 * (`lib/effect/saas-guards.ts`), so in the API SERVER it never reaches this seam.
 * Three classes still do reach it, and the degrade is deliberate for all three:
 *
 *   1. the dev-relaxed boot (`ATLAS_DEPLOY_ENV=development`);
 *   2. throw classes a boot-time env check cannot predict — a `./python` import
 *      that fails at build time, say;
 *   3. processes that never build the app Layer at all, so no guard runs in
 *      front of them. `buildAppLayer` has exactly one non-test caller
 *      (`api/server.ts`); `packages/mcp`'s `atlas-mcp` binary calls only
 *      `initializeConfig()` and reaches here via `executeAgentQuery`. That is
 *      the honest limit of the guard's reach, and it is why this fallback stays.
 *
 * For all three, degrading to the lesser-privileged registry — with a warning the
 * model can relay — is the right answer for a surface with no human in the loop.
 */
export async function buildHeadlessRegistry(): Promise<BuildRegistryResult> {
  try {
    return await buildRegistry({
      includeActions: process.env.ATLAS_ACTIONS_ENABLED === "true",
      dashboardUrlResolver: null,
    });
  } catch (err) {
    const { createLogger } = await import("@atlas/api/lib/logger");
    createLogger("registry").error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to build headless tool registry — falling back to the non-dashboard core registry",
    );
    return { registry: nonDashboardRegistry, warnings: [registryBuildFailedWarning()] };
  }
}

export { defaultRegistry, nonDashboardRegistry };
