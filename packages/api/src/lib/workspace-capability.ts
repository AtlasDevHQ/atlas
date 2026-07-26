/**
 * Workspace capability probe — "is there anything here the agent can serve?"
 *
 * The chat route used to answer that question with a process-level env check
 * (`resolveDatasourceUrl()`), which conflated *the operator set an env var* with
 * *this tenant has data*. That made every knowledge-only or brain-only
 * deployment unusable through the primary surface, even though `searchBrain`
 * and the Knowledge Base read exclusively from the internal DB and need no
 * analytics datasource at all (#4826).
 *
 * A workspace is servable when it has **any** of the three agent-facing
 * pillars:
 *   - `datasource` — a registered analytics datasource (or, for a self-hosted
 *     single-tenant deployment, a process-level `ATLAS_DATASOURCE_URL`)
 *   - `knowledge`  — at least one installed Knowledge Base collection (ADR-0028)
 *   - `brain`      — at least one brain fact or episode (ADR-0036)
 *
 * **This is not an authorization boundary.** The probe returns booleans about
 * *configuration*, never content, and deliberately ignores `visible_to` ACL
 * grants and draft/published content mode — per-user reach is enforced inside
 * `searchBrain` / `searchKnowledge` / the SQL pipeline, which is where it
 * belongs. Widening this probe to consider ACLs would leak nothing but would
 * turn a cheap gate into a per-user query for no benefit; narrowing the gate on
 * ACLs would let a reach miss masquerade as "this workspace is empty".
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { resolveDatasourceUrl } from "@atlas/api/lib/db/connection";
// Type-only: erased at runtime, so this module adds no import that the many
// partial `mock.module("@atlas/api/lib/startup")` test doubles would have to
// grow a new key for.
import type { DiagnosticCode, DiagnosticError } from "@atlas/api/lib/startup";

const log = createLogger("workspace-capability");

/**
 * Diagnostics that describe the **process-level** analytics datasource — the
 * self-hosted single-tenant `ATLAS_DATASOURCE_URL` and the on-disk semantic
 * layer generated from it.
 *
 * A workspace-bound (multi-tenant) request resolves its datasource and semantic
 * layer per tenant from the DB, so none of these describe anything it depends
 * on. Reporting them to a bound workspace is how a knowledge-only or brain-only
 * deployment got told to "set ATLAS_DATASOURCE_URL": every deployment with an
 * internal `DATABASE_URL` and no analytics URL raises `MISSING_DATASOURCE_URL`
 * (see `checkDatasourceUrlPresence` in `lib/startup.ts`), which is the steady
 * state for the very deployments this filter unblocks (#4826).
 *
 * Everything NOT listed here — provider keys, internal DB reachability, auth
 * prerequisites, action credentials — blocks chat for *every* tenancy shape and
 * is deliberately still reported.
 */
export const PROCESS_DATASOURCE_DIAGNOSTICS: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "MISSING_DATASOURCE_URL",
  "MISSING_SEMANTIC_LAYER",
  "DB_UNREACHABLE",
  "INVALID_SCHEMA",
]);

/**
 * Drop the process-level analytics-datasource diagnostics, keeping the ones
 * that block a bound workspace regardless of how it gets its data.
 *
 * For workspace-bound requests only; an unbound (self-hosted single-tenant)
 * request has nothing *but* the process-level datasource, so it must keep
 * seeing the full set.
 */
export function diagnosticsForBoundWorkspace(
  diagnostics: readonly DiagnosticError[],
): DiagnosticError[] {
  return diagnostics.filter((d) => !PROCESS_DATASOURCE_DIAGNOSTICS.has(d.code));
}

/** An agent-facing pillar a workspace can be adopted for. */
export type WorkspaceCapability = "datasource" | "knowledge" | "brain";

/**
 * Outcome of a capability probe.
 *
 * `unknown` exists so a transient internal-DB fault can never be mistaken for
 * "this workspace is empty". The gate blocks only on a *resolved* empty set —
 * an undecidable probe fails **open** (see `probeWorkspaceCapabilities`).
 */
export type CapabilityProbe =
  | { readonly kind: "resolved"; readonly capabilities: ReadonlySet<WorkspaceCapability> }
  | { readonly kind: "unknown"; readonly reason: string };

interface CapabilityRow extends Record<string, unknown> {
  has_datasource: boolean;
  has_knowledge: boolean;
  has_brain: boolean;
}

/**
 * One indexed round-trip against the internal DB. Every predicate is covered by
 * a leading-`workspace_id` index (`idx_workspace_plugins_status`,
 * `idx_brain_facts_status`, `idx_brain_episodes_source`), so this is an
 * index-only existence check rather than a scan — cheap enough for the chat hot
 * path, which already awaits the billing gate and the migration write-lock.
 *
 * Deliberately uncached: a cache would make the first minute after a user
 * connects their first datasource — the exact onboarding moment this gate is
 * most visible — report stale emptiness.
 */
const CAPABILITY_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM workspace_plugins
       WHERE workspace_id = $1 AND pillar = 'datasource' AND status <> 'archived'
    ) AS has_datasource,
    EXISTS (
      SELECT 1 FROM workspace_plugins
       WHERE workspace_id = $1 AND pillar = 'knowledge' AND status <> 'archived'
    ) AS has_knowledge,
    (
      EXISTS (SELECT 1 FROM brain_facts WHERE workspace_id = $1 AND status <> 'archived')
      OR EXISTS (SELECT 1 FROM brain_episodes WHERE workspace_id = $1)
    ) AS has_brain
`;

/**
 * Resolve which pillars `workspaceId` can be served from.
 *
 * Fails **open** (`kind: "unknown"`) when the internal DB is absent or the probe
 * throws. This gate is a UX affordance — it turns "the agent flailed" into an
 * actionable refusal — not a security control, so a DB blip must not take chat
 * down for workspaces that are perfectly well configured. Every tool still
 * enforces its own preconditions per call.
 */
export async function probeWorkspaceCapabilities(workspaceId: string): Promise<CapabilityProbe> {
  const capabilities = new Set<WorkspaceCapability>();

  // Self-hosted single-tenant fallback: a process-level analytics datasource
  // serves whichever workspace is bound to it.
  if (resolveDatasourceUrl()) capabilities.add("datasource");

  if (!hasInternalDB()) {
    // No internal DB means no `workspace_plugins` / `brain_*` tables to consult.
    // The env-level datasource above is the only thing that could be true, so
    // report it rather than pretending we probed the tenant tables.
    return capabilities.size > 0
      ? { kind: "resolved", capabilities }
      : { kind: "unknown", reason: "no internal database configured" };
  }

  let rows: CapabilityRow[];
  try {
    rows = await internalQuery<CapabilityRow>(CAPABILITY_SQL, [workspaceId]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ err: err instanceof Error ? err : new Error(reason), workspaceId }, "Workspace capability probe failed — allowing the turn through");
    return { kind: "unknown", reason };
  }

  const row = rows[0];
  if (!row) {
    // An `EXISTS`-only SELECT with no FROM always yields exactly one row; zero
    // rows means something upstream (a mock, a proxy) is not behaving like
    // Postgres. Treat it as undecidable rather than as emptiness.
    log.warn({ workspaceId }, "Workspace capability probe returned no rows — allowing the turn through");
    return { kind: "unknown", reason: "capability probe returned no rows" };
  }

  if (row.has_datasource) capabilities.add("datasource");
  if (row.has_knowledge) capabilities.add("knowledge");
  if (row.has_brain) capabilities.add("brain");

  return { kind: "resolved", capabilities };
}

/**
 * The refusal a genuinely empty workspace gets.
 *
 * Names all three pillars rather than assuming the missing one is a datasource
 * — the old message told brain-only adopters to set `ATLAS_DATASOURCE_URL`,
 * which is precisely the thing they had deliberately not configured (#4826).
 */
export const NO_CAPABILITY_MESSAGE =
  "This workspace has nothing for Atlas to work with yet. Connect a data source to query your data, " +
  "add a Knowledge Base collection, or let the Company Brain learn from your team's activity.";
