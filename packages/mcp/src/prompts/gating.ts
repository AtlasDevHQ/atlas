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

import type { CanonicalToggle } from "@useatlas/types/mcp";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

export const EXPOSE_CANONICAL_SETTING = "ATLAS_MCP_EXPOSE_CANONICAL_PROMPTS";

/**
 * Re-exported for backend-only callers. The admin page imports the type
 * directly from `@useatlas/types/mcp` because frontend can't depend on
 * `@atlas/api`. See `packages/types/src/mcp.ts` for why the matching
 * const tuple lives in callers, not here.
 */
export type { CanonicalToggle };

export interface ShouldExposeCanonicalOpts {
  /** Active workspace id (`actor.activeOrganizationId`). May be undefined for stdio without bound user. */
  readonly workspaceId?: string;
}

/**
 * UI-facing reason key for why the canonical-gate is closed. `null`
 * when canonical prompts are exposed (no banner needed). The HTTP
 * endpoint `/api/v1/me/mcp-prompts` (#2179) surfaces these so the
 * Settings → AI Agents preview block can render the right banner copy
 * — e.g. "an admin disabled them" vs "we couldn't auto-detect a demo
 * workspace". Distinct from the boolean the SDK list handler needs
 * because the SDK simply hides closed-gate prompts; the workspace UI
 * needs to *explain* the absence.
 */
export type CanonicalGateReason = "toggle-never" | "no-demo-signal";

export interface CanonicalGateResult {
  readonly exposed: boolean;
  readonly toggle: CanonicalToggle;
  /** UI-facing reason key when `exposed=false`, otherwise `null`. */
  readonly reason: CanonicalGateReason | null;
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

/**
 * Rich evaluator — same gate logic as `shouldExposeCanonicalPrompts`,
 * but returns the resolved toggle + reason key so the UI can explain
 * the closed-gate state. The boolean wrapper below stays for callers
 * that only care about visibility (the SDK `prompts/list` override).
 */
export async function evaluateCanonicalGate(
  opts: ShouldExposeCanonicalOpts,
): Promise<CanonicalGateResult> {
  const toggle = readToggle(opts.workspaceId);
  if (toggle === "always") {
    return { exposed: true, toggle, reason: null };
  }
  if (toggle === "never") {
    return { exposed: false, toggle, reason: "toggle-never" };
  }

  if (opts.workspaceId) {
    const demoActive = await hasPublishedDemoConnection(opts.workspaceId);
    if (demoActive) return { exposed: true, toggle, reason: null };
  }
  if (hasDemoIndustry(opts.workspaceId)) {
    return { exposed: true, toggle, reason: null };
  }
  return { exposed: false, toggle, reason: "no-demo-signal" };
}

export async function shouldExposeCanonicalPrompts(
  opts: ShouldExposeCanonicalOpts,
): Promise<boolean> {
  return (await evaluateCanonicalGate(opts)).exposed;
}
