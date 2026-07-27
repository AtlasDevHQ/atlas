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
 *   - `datasource` — a registered analytics datasource, or a process-level
 *     `ATLAS_DATASOURCE_URL` (which counts for every workspace probed — see the
 *     note in `probeWorkspaceCapabilities`, not just single-tenant deployments)
 *   - `knowledge`  — at least one installed Knowledge Base collection (ADR-0028)
 *   - `brain`      — at least one brain episode. Every fact necessarily has one
 *     (composite FK), so episodes subsume facts; the converse does NOT hold —
 *     an unextracted episode has no facts at all (ADR-0036)
 *
 * **This is not an authorization boundary.** The probe returns booleans about
 * *existence*, never the content itself, and deliberately ignores `visible_to`
 * ACL grants and draft/published content mode — per-user reach is enforced
 * inside `searchBrain` and the SQL pipeline, which is where it belongs. Widening
 * this probe to consider ACLs would leak nothing but would turn a cheap gate
 * into a per-user query for no benefit; narrowing the gate on ACLs would let a
 * reach miss masquerade as "this workspace is empty".
 *
 * One consequence of ignoring content mode: a workspace whose only install is a
 * `draft` datasource or collection passes the gate, then meets an agent that in
 * published mode sees nothing — the "agent flailed" outcome the gate exists to
 * prevent. Threading the request's `atlasMode` through is the escape hatch if
 * this ever bites — and note it is specifically a MODE-AWARE narrowing that
 * works: filtering to `status = 'published'` unconditionally would refuse an
 * admin mid-setup in developer mode, whereas the developer-mode overlay admits
 * `('draft','published')` and would not. It was simply not worth the extra
 * parameter for a gate that is an affordance.
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
 * Every diagnostic scoped to the **process-level** analytics datasource — the
 * `ATLAS_DATASOURCE_URL` connection and the base-root semantic layer generated
 * from it (`checkDatasourceUrlPresence`, `checkSemanticLayerPresence`,
 * `checkDatasourceConnectivity` in `lib/startup.ts`).
 *
 * Membership says only "this describes the process datasource". Whether it is
 * *relevant* is a separate question, answered per request — see
 * `diagnosticsForBoundWorkspace`.
 */
export const PROCESS_DATASOURCE_DIAGNOSTICS: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "MISSING_DATASOURCE_URL",
  "MISSING_SEMANTIC_LAYER",
  "DB_UNREACHABLE",
  "INVALID_SCHEMA",
]);

/**
 * Report a bound workspace only the diagnostics that describe something it
 * actually depends on.
 *
 * **One rule: the process datasource is relevant exactly when it exists.**
 * `probeWorkspaceCapabilities` counts a resolved `ATLAS_DATASOURCE_URL` as this
 * workspace's `datasource` pillar, so when one is configured every diagnostic
 * about it — unreachable, bad schema, missing semantic layer — describes a
 * connection this turn may genuinely be about to use, and must still block.
 * When none is configured, the workspace is served entirely from the DB
 * (`resolveAllowedTables` never widens to disk; the datasource comes from
 * `workspace_plugins`) and none of them describe anything it depends on.
 *
 * That single condition is what unblocks #4826: a knowledge-only or brain-only
 * deployment sets `DATABASE_URL` and no analytics URL, which raises
 * `MISSING_DATASOURCE_URL` permanently and used to 400 every chat turn.
 *
 * Deriving the behaviour from one predicate rather than hand-classifying each
 * code is deliberate. The earlier revision curated an "absence-shaped" subset,
 * which was wrong: `MISSING_SEMANTIC_LAYER` also carries a read-failure variant
 * ("Could not read semantic layer directory … check file permissions"), so an
 * EACCES on the semantic root would have been swallowed even for a workspace
 * whose datasource — and therefore whose on-disk entities — genuinely exist.
 * Unlike the connectivity codes this one is NOT self-enforcing:
 * `checkSemanticLayerPresence` runs unconditionally, so an EACCES on a
 * deployment with no analytics URL is still dropped. That is the right call —
 * such a workspace resolves its whitelist from the DB — but it is a trade, not
 * an impossibility.
 *
 * Note the condition is self-enforcing for the two connectivity codes:
 * `validateEnvironment` runs `checkDatasourceConnectivity` only when a URL
 * resolved, so `DB_UNREACHABLE` / `INVALID_SCHEMA` can only be emitted in the
 * state where this function keeps them. Likewise `MISSING_DATASOURCE_URL` is
 * emitted only when the URL is absent — the state where it is dropped.
 *
 * Everything outside the set — provider keys, internal DB reachability, auth
 * prerequisites, action credentials — blocks chat for *every* tenancy shape and
 * is never filtered.
 *
 * For workspace-bound requests only; an unbound request has nothing *but* the
 * process-level datasource, so it must keep seeing the full set.
 */
export function diagnosticsForBoundWorkspace(
  diagnostics: readonly DiagnosticError[],
): DiagnosticError[] {
  const processDatasourceInPlay = Boolean(resolveDatasourceUrl());
  if (processDatasourceInPlay) return [...diagnostics];

  const kept: DiagnosticError[] = [];
  const dropped: DiagnosticCode[] = [];
  for (const d of diagnostics) {
    if (PROCESS_DATASOURCE_DIAGNOSTICS.has(d.code)) dropped.push(d.code);
    else kept.push(d);
  }
  if (dropped.length > 0) {
    // `debug`, not `warn`: this fires on every bound request for the steady
    // state it exists to serve, so it would drown the log at any higher level.
    // Nothing is lost by that — the diagnostic was already `log.error`'d at
    // emission (`startup.ts`) and stays visible on `/health`; this line only
    // records that CHAT chose not to surface it, for someone who has already
    // raised the level to ask why.
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
 * One round-trip against the internal DB. Every predicate leads with
 * `workspace_id`, and each table carries at least one leading-`workspace_id`
 * index, so no `EXISTS` degenerates into a table scan — cheap enough for the
 * chat hot path, which already awaits the billing gate and the migration
 * write-lock. (`pillar`, and the `<>` on `status`, are filters rather than index
 * bounds; fine at the row counts one workspace's install list reaches.)
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
    -- Note both install predicates ignore the enabled flag and exclude only
    -- archived rows. That errs permissive, which is the safe direction for an
    -- affordance gate: it can never produce the false refusal this module
    -- exists to prevent.
    -- Episodes alone decide the brain pillar, and that is not an oversight:
    -- brain_facts.source_episode_id is NOT NULL with a COMPOSITE foreign key on
    -- (workspace_id, source_episode_id), so a fact cannot exist without an
    -- episode in the same workspace. An additional EXISTS over brain_facts
    -- could never change the answer — it would just be a second index probe on
    -- the hot path. (brain_episodes also carries no status column: tier 3 is
    -- append-only and not content-mode managed, so there is nothing to exclude.
    -- Adding a status predicate here is a runtime error, not a tidy-up.)
    EXISTS (SELECT 1 FROM brain_episodes WHERE workspace_id = $1) AS has_brain
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
  // OID 16 to a JS boolean, so this is the honest read of the contract.
  //
  // Be clear about the failure direction, because it is NOT covered by the
  // fail-open branches above: a driver that ever returned the strings `"t"`/
  // `"f"` would produce no throw, a non-empty row, and three `false` flags —
  // a `resolved` empty set, refusing every bound workspace on any deployment
  // without a process-level `ATLAS_DATASOURCE_URL`: i.e. the whole SaaS fleet,
  // and every knowledge-only or brain-only self-host. That is precisely the
  // #4826 bug it would recreate, which is why
  // `workspace-capability-pg.test.ts` pins `typeof === "boolean"` against a
  // real driver rather than trusting this comment.
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
