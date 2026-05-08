/**
 * Workspace gating for canonical-questions prompts (#2076).
 *
 * Tri-state toggle (`ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS` workspace setting):
 *   - `always` — admin opted in (real-data workspace wants the NovaMart
 *                prompts as examples).
 *   - `never`  — admin opted out (demo workspace running an experiment
 *                without canonical prompts in the picker).
 *   - `auto` (default, also unset) — read the dataset signal and only
 *                expose for demo workspaces.
 *
 * Demo-workspace signals, in priority order:
 *   1. Org has a published `__demo__` connection (the canonical
 *      onboarding fixture, #2021). Skipped when the internal DB is
 *      unavailable.
 *   2. `ATLAS_DEMO_INDUSTRY` is set on the workspace. The onboarding
 *      flow writes this when the user picks the NovaMart demo, so it
 *      survives a connection-query failure and covers the platform
 *      scope (no orgId required).
 *
 * "Fail closed" on errors: a connections-query failure that ALSO has
 * no industry setting means we don't know if this is a demo workspace,
 * so we hide canonical prompts. Better to under-surface than to bleed
 * NovaMart prompts into a real-data workspace.
 */

import { getSettingAuto } from "@atlas/api/lib/settings";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

export const EXPOSE_CANONICAL_SETTING = "ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS";

export type CanonicalToggle = "always" | "never" | "auto";

export interface ShouldExposeCanonicalOpts {
  /** Active workspace id (`actor.activeOrganizationId`). May be undefined for stdio without bound user. */
  readonly workspaceId?: string;
}

function readToggle(workspaceId: string | undefined): CanonicalToggle {
  const raw = getSettingAuto(EXPOSE_CANONICAL_SETTING, workspaceId);
  if (raw === "always" || raw === "never") return raw;
  return "auto";
}

async function hasPublishedDemoConnection(
  workspaceId: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  try {
    const rows = await internalQuery<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM connections
         WHERE id = '__demo__' AND org_id = $1 AND status = 'published'
       ) AS active`,
      [workspaceId],
    );
    return rows[0]?.active === true;
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] canonical gating: connections query failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

function hasDemoIndustry(workspaceId: string | undefined): boolean {
  const value = getSettingAuto("ATLAS_DEMO_INDUSTRY", workspaceId);
  return typeof value === "string" && value.length > 0;
}

export async function shouldExposeCanonicalPrompts(
  opts: ShouldExposeCanonicalOpts,
): Promise<boolean> {
  const toggle = readToggle(opts.workspaceId);
  if (toggle === "always") return true;
  if (toggle === "never") return false;

  // toggle === "auto" — fall back to dataset detection.
  if (opts.workspaceId) {
    const demoActive = await hasPublishedDemoConnection(opts.workspaceId);
    if (demoActive) return true;
  }
  return hasDemoIndustry(opts.workspaceId);
}
