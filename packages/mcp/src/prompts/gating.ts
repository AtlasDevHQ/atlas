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
 * UI-facing reason key for why the canonical-gate is closed. The HTTP
 * endpoint `/api/v1/me/mcp-prompts` (#2179) surfaces these so the
 * Settings → AI Agents preview block can render the right banner copy.
 * Distinct from the boolean the SDK list handler needs because the
 * SDK simply hides closed-gate prompts; the workspace UI needs to
 * *explain* the absence.
 *
 * Three closed-gate paths:
 *   - `toggle-never`        — admin opted out at Admin → Settings → MCP.
 *   - `no-demo-signal`      — toggle=auto, the workspace has no
 *                             `__demo__` connection AND no
 *                             `ATLAS_DEMO_INDUSTRY` setting.
 *   - `signal-unavailable`  — toggle=auto, but the connections probe
 *                             failed (internal DB outage, schema drift,
 *                             etc.) AND no industry signal could
 *                             confirm demo status either way. Distinct
 *                             from `no-demo-signal` because the user-
 *                             actionable advice differs ("retry / file
 *                             a ticket" vs "this isn't a demo
 *                             workspace") and operators dogfooding the
 *                             SaaS need an in-product signal that
 *                             something is broken.
 *
 * Mirrored as a Zod enum at:
 *   - `packages/api/src/api/routes/me-mcp-prompts.ts` (route response)
 *   - `packages/web/src/ui/lib/me-schemas.ts` (web client parse)
 * Keep all three lockstep; there is no shared schema module yet (see
 * the `@useatlas/types` value-export caveat documented at
 * `packages/web/src/app/admin/settings/mcp/page.tsx:34-42`).
 */
export type CanonicalGateReason =
  | "toggle-never"
  | "no-demo-signal"
  | "signal-unavailable";

/**
 * Discriminated union encoding the invariant `exposed=true ⇒ reason=null`
 * directly in the type system — consumers narrow on `exposed` instead
 * of defending against a "shouldn't happen" null/non-null pair.
 */
export type CanonicalGateResult =
  | { readonly exposed: true; readonly toggle: CanonicalToggle; readonly reason: null }
  | { readonly exposed: false; readonly toggle: CanonicalToggle; readonly reason: CanonicalGateReason };

/**
 * Tri-state demo-connection probe result. Distinct from a `boolean`
 * because "couldn't determine" is a different forensic state from
 * "verified-not-a-demo-workspace" — the loss of information happens
 * at the call site (where we can decide policy) rather than inside
 * the helper.
 */
type DemoConnectionProbe = "active" | "inactive" | "error";

function readToggle(workspaceId: string | undefined): CanonicalToggle {
  const raw = getSettingAuto(EXPOSE_CANONICAL_SETTING, workspaceId);
  if (raw === "always" || raw === "never") return raw;
  return "auto";
}

async function probeDemoConnection(
  workspaceId: string,
): Promise<DemoConnectionProbe> {
  if (!hasInternalDB()) return "inactive";
  try {
    const rows = await internalQuery<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM connections
         WHERE id = '__demo__' AND org_id = $1 AND status = 'published'
       ) AS active`,
      [workspaceId],
    );
    return rows[0]?.active === true ? "active" : "inactive";
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] canonical gating: connections query failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return "error";
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
 *
 * Reason resolution under `auto`:
 *   1. Connections probe → if active OR industry signal set, expose.
 *   2. Connections probe inactive AND no industry → `no-demo-signal`.
 *   3. Connections probe errored AND no industry → `signal-unavailable`
 *      (we genuinely couldn't determine demo status — distinct from
 *      "this isn't a demo workspace" so the UI advice can differ).
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

  let probe: DemoConnectionProbe = "inactive";
  if (opts.workspaceId) {
    probe = await probeDemoConnection(opts.workspaceId);
    if (probe === "active") return { exposed: true, toggle, reason: null };
  }
  if (hasDemoIndustry(opts.workspaceId)) {
    return { exposed: true, toggle, reason: null };
  }
  // Industry signal absent — disambiguate by probe result. Probe-errored
  // case must NOT collapse into `no-demo-signal` because the UI advice
  // ("Atlas only surfaces canonical prompts to demo workspaces") is
  // misleading when the actual cause was a DB outage.
  if (probe === "error") {
    return { exposed: false, toggle, reason: "signal-unavailable" };
  }
  return { exposed: false, toggle, reason: "no-demo-signal" };
}

export async function shouldExposeCanonicalPrompts(
  opts: ShouldExposeCanonicalOpts,
): Promise<boolean> {
  return (await evaluateCanonicalGate(opts)).exposed;
}
