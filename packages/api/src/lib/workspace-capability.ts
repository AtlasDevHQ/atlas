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
 * `searchBrain` and the SQL pipeline, which is where it belongs. Widening this
 * probe to consider ACLs would leak nothing but would turn a cheap gate into a
 * per-user query for no benefit; narrowing the gate on ACLs would let a reach
 * miss masquerade as "this workspace is empty".
 *
 * One consequence of ignoring content mode: a workspace whose only install is a
 * `draft` datasource or collection passes the gate, then meets an agent that in
 * published mode sees nothing — the "agent flailed" outcome the gate exists to
 * prevent. Accepted, because narrowing on mode would instead refuse the turn for
 * an admin who is mid-setup in developer mode, which is worse.
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
 * Diagnostics that report the **absence** of the process-level analytics
 * datasource, or of the on-disk semantic layer generated from it.
 *
 * A bound workspace resolves its whitelist per tenant from the DB
 * (`resolveAllowedTables` never widens to disk), and gets its datasource from
 * `workspace_plugins` — so neither absence describes anything it depends on.
 * Reporting them anyway is how a knowledge-only or brain-only deployment got
 * told to "set ATLAS_DATASOURCE_URL": every deployment with an internal
 * `DATABASE_URL` and no analytics URL raises `MISSING_DATASOURCE_URL` (see
 * `checkDatasourceUrlPresence` in `lib/startup.ts`), which is the steady state
 * for the very deployments this filter unblocks (#4826).
 *
 * **Absence only — never ill health.** `DB_UNREACHABLE` and `INVALID_SCHEMA`
 * are deliberately NOT here. `validateEnvironment` runs
 * `checkDatasourceConnectivity` only when a process datasource URL actually
 * resolved, and when one has, `probeWorkspaceCapabilities` counts it as this
 * workspace's `datasource` capability — so those two diagnostics describe a
 * connection a bound workspace may genuinely be about to use. Filtering them
 * would trade an actionable "your analytics DB is unreachable" 400 for a turn
 * that burns tokens and dies inside the agent loop.
 *
 * Everything else — provider keys, internal DB reachability, auth
 * prerequisites, action credentials — blocks chat for *every* tenancy shape and
 * is likewise still reported.
 */
export const PROCESS_DATASOURCE_DIAGNOSTICS: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "MISSING_DATASOURCE_URL",
  "MISSING_SEMANTIC_LAYER",
]);

/**
 * Drop the process-level analytics-datasource *absence* diagnostics, keeping
 * every diagnostic that still describes something a bound workspace depends on.
 *
 * For workspace-bound requests only; an unbound (self-hosted single-tenant)
 * request has nothing *but* the process-level datasource, so it must keep
 * seeing the full set.
 */
export function diagnosticsForBoundWorkspace(
  diagnostics: readonly DiagnosticError[],
): DiagnosticError[] {
  const kept: DiagnosticError[] = [];
  const dropped: DiagnosticCode[] = [];
  for (const d of diagnostics) {
    if (PROCESS_DATASOURCE_DIAGNOSTICS.has(d.code)) dropped.push(d.code);
    else kept.push(d);
  }
  if (dropped.length > 0) {
    // A discarded diagnostic is still a discarded signal — leave a trace so an
    // operator debugging "why did chat not tell me X" can see the suppression.
    log.debug({ dropped }, "Suppressed process-datasource diagnostics for a workspace-bound request");
  }
  return kept;
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
  /**
   * The probe could not decide. `reason` is **log-only** — never place it in a
   * response body, since a driver error can carry host/database detail
   * (CLAUDE.md, "No secrets in responses").
   */
  | { readonly kind: "unknown"; readonly reason: string };

interface CapabilityRow extends Record<string, unknown> {
  readonly has_datasource: boolean;
  readonly has_knowledge: boolean;
  readonly has_brain: boolean;
}

/**
 * One round-trip against the internal DB. Each `EXISTS` is scoped by a
 * leading-`workspace_id` index (`idx_workspace_plugins_status`,
 * `idx_brain_facts_status`, `idx_brain_episodes_source`), so each is a bounded
 * index probe rather than a table scan — cheap enough for the chat hot path,
 * which already awaits the billing gate and the migration write-lock. (`pillar`
 * is carried by no index, so it is a heap-side recheck; fine at the row counts
 * a single workspace's install list reaches.)
 *
 * Deliberately uncached: a cache would make the first minute after a user
 * connects their first datasource — the exact onboarding moment this gate is
 * most visible — report stale emptiness.
 */
export const CAPABILITY_SQL = `
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
      -- brain_episodes carries no status column (tier 3 is append-only and not
      -- content-mode managed), so there is nothing to exclude here. Do not
      -- "fix" the asymmetry — adding a status predicate is a runtime error.
      OR EXISTS (SELECT 1 FROM brain_episodes WHERE workspace_id = $1)
    ) AS has_brain
`;

/**
 * Resolve which pillars `workspaceId` can be served from.
 *
 * Fails **open** (`kind: "unknown"`) when the probe throws, returns no rows, or
 * there is no internal DB *and* no process-level datasource to fall back on.
 * This gate is a UX affordance — it turns "the agent flailed" into an actionable
 * refusal — not a security control, so a DB blip must not take chat down for
 * workspaces that are perfectly well configured. Every tool still enforces its
 * own preconditions per call.
 */
export async function probeWorkspaceCapabilities(workspaceId: string): Promise<CapabilityProbe> {
  const capabilities = new Set<WorkspaceCapability>();

  // A process-level analytics datasource satisfies this pillar for EVERY
  // workspace probed — it is a process-global fallback, not a per-tenant
  // binding. Harmless because a multi-tenant deployment never sets one (the
  // connection lives in the workspace's registered datasources, #4124), and
  // because this gate is an affordance rather than an authorization boundary.
  if (resolveDatasourceUrl()) capabilities.add("datasource");

  if (!hasInternalDB()) {
    // No internal DB means no `workspace_plugins` / `brain_*` tables to consult.
    // The env-level datasource above is the only thing that could be true, so
    // report it rather than pretending we probed the tenant tables.
    if (capabilities.size > 0) return { kind: "resolved", capabilities };
    log.warn({ workspaceId }, "Workspace capability probe has no internal database — allowing the turn through");
    return { kind: "unknown", reason: "no internal database configured" };
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

  // `=== true` rather than truthiness: `EXISTS` is NULL-free and node-pg parses
  // OID 16 to a JS boolean, so this is the honest read of the contract. If a
  // driver ever handed back `"t"`, an explicit compare fails safe toward
  // "no capability" only in combination with the fail-open branches above.
  if (row.has_datasource === true) capabilities.add("datasource");
  if (row.has_knowledge === true) capabilities.add("knowledge");
  if (row.has_brain === true) capabilities.add("brain");

  return { kind: "resolved", capabilities };
}

/**
 * The single refusal predicate both chat gates use.
 *
 * Exists so the two-part condition ("resolved AND empty") is stated once. A
 * future third call site writing the inverted `probe.kind !== "resolved" || …`
 * would compile and silently reintroduce the fail-closed behaviour this module
 * exists to prevent.
 */
export function shouldRefuseTurn(probe: CapabilityProbe): boolean {
  return probe.kind === "resolved" && probe.capabilities.size === 0;
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
