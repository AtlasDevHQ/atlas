/**
 * Bound dashboard tool registry (#2363).
 *
 * The bound agent has a strict editor tool surface:
 *   - explore + executeSQL — same as the default agent (needed to verify
 *     SQL shape before `addCard`).
 *   - getDashboardState, getCardDetail, addCard, updateCard, updateLayout,
 *     updateDashboardMeta — the six safe editor tools.
 *
 * Explicitly NOT included:
 *   - executePython — out of scope for dashboard editing; the bound agent
 *     should not run arbitrary Python in the middle of an edit session.
 *   - action plugins (createJiraTicket, sendEmailReport) — irrelevant to
 *     dashboard composition; including them just confuses the model.
 *   - proposeDashboard — superseded by the bound editor tools. The root-
 *     chat flow keeps proposeDashboard until #2369 reframes it as
 *     `createDashboard`; the bound flow drops it outright.
 *
 * Plugin tools are NOT merged here. Plugin-registered tools target the
 * general agent loop; the bound surface is intentionally narrow. If a
 * future plugin specifically targets dashboard editing it can opt-in
 * via a separate hook.
 */

import { ToolRegistry, EXPLORE_DESCRIPTION, EXECUTE_SQL_DESCRIPTION } from "./registry";
import { explore } from "./explore";
import { executeSQL } from "./sql";
import {
  createBoundDashboardTools,
  BOUND_DASHBOARD_TOOL_DESCRIPTIONS,
  type BoundDashboardToolContext,
} from "./bound-dashboard";

/**
 * Build a frozen tool registry for the bound-dashboard agent loop.
 * Captures the dashboardId + orgId in the tools' closure — the LLM
 * cannot redirect a turn at a different dashboard.
 */
export function buildBoundDashboardRegistry(
  ctx: BoundDashboardToolContext,
): ToolRegistry {
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

  const editorTools = createBoundDashboardTools(ctx);
  for (const [name, tool] of Object.entries(editorTools)) {
    registry.register({
      name,
      description: BOUND_DASHBOARD_TOOL_DESCRIPTIONS[name] ?? `### ${name}\n(no description)`,
      tool,
    });
  }

  registry.freeze();
  return registry;
}
