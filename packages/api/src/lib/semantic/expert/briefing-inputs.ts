/**
 * Briefing input loader (#4514) — the IMPURE gather behind the pure
 * `assembleBriefing` seam (`briefing.ts`).
 *
 * Fills the briefing's inputs from data the workspace already tracks — never by
 * re-querying the customer database just to start a chat (#4514 AC3):
 *
 *   - Entities + glossary — from the org's DB rows / disk mirror (the same merge
 *     the Health card + file tree read, via `context-loader`).
 *   - Profiles — the TRACKED baseline `TableProfile[]` stored per connection
 *     (`connection_profile_state`, #4509), with a pre-computed staleness marker.
 *     Falls back to the CLI disk cache when there's no internal DB.
 *   - Audit patterns + rejection memory — org-scoped, from the internal DB.
 *   - Pending queue + recent panel decisions — the amendment review state.
 *
 * The same `loadAnalysisContext` builds the `AnalysisContext` the health endpoint
 * scores (replacing its old empty-inputs call) AND the context the analyzer mines
 * for the briefing's findings — so the two can never diverge on what "the current
 * state" is.
 */

import type { TableProfile } from "@useatlas/types";
import { createLogger } from "@atlas/api/lib/logger";
import type { AnalysisContext } from "./types";
import { computeSemanticHealth } from "./health";
import { analyzeSemanticLayer } from "./analyzer";
import type { BriefingInputs, BriefingProfileLine, HealthStatus } from "./briefing";

const log = createLogger("semantic-expert-briefing");

/** Read mode for the entity source — published (admin default) or developer overlay. */
type EntityMode = "published" | "developer";

/**
 * The health status discriminator: a parse-failure zero ("corrupt") is not the
 * same as a no-data zero ("no_entities"). Shared by the health endpoint and the
 * briefing so both read the SAME rule. `corrupt` gates on `totalRows`
 * (DB-rows-considered) so a healthy disk mirror can't mask the corruption; empty
 * gates on the merged `entityCount` (#2503).
 */
export function deriveHealthStatus(
  parseFailures: number,
  totalRows: number,
  entityCount: number,
): HealthStatus {
  if (parseFailures > 0 && parseFailures === totalRows && totalRows > 0) return "corrupt";
  if (entityCount === 0) return "no_entities";
  return "ok";
}

/**
 * Load the TRACKED profile payload + per-connection anchor lines for a workspace.
 *
 * On SaaS / self-hosted-with-DB: reads the stored baseline `TableProfile[]` per
 * connection from `connection_profile_state` (#4509) and derives a freshness
 * marker per connection — NO live customer-database query. Falls back to the CLI
 * disk cache (`loadCachedProfiles`) when there is no internal DB (bare CLI /
 * self-hosted stdio). `now` is injected so the freshness marker is deterministic
 * under test.
 */
export async function loadTrackedProfiles(
  orgId: string | null,
  now: Date,
): Promise<{ profiles: TableProfile[]; lines: BriefingProfileLine[] }> {
  const { hasInternalDB } = await import("@atlas/api/lib/db/internal");

  if (!orgId || !hasInternalDB()) {
    // No internal DB → the only tracked profiles are the CLI disk cache. It
    // carries no per-connection freshness rows, so there are no anchor lines.
    const { loadCachedProfiles } = await import("./profile-cache");
    return { profiles: loadCachedProfiles(), lines: [] };
  }

  const { listConnectionProfileStates, getBaselineProfiles, describeProfileFreshness } =
    await import("@atlas/api/lib/semantic/connection-profile");

  const states = await listConnectionProfileStates(orgId);
  const profiles: TableProfile[] = [];
  const lines: BriefingProfileLine[] = [];

  for (const state of states) {
    const freshness = describeProfileFreshness(state.baseline?.profiledAt ?? null, now);
    lines.push({
      connection: state.installId,
      dbType: state.dbType,
      freshness: freshness?.label ?? null,
      tableCount: state.baseline?.tableCount ?? null,
    });
    // Pull the stored baseline payload for the analyzer/health. A connection with
    // only a failed baseline (payload null) contributes an anchor line but no
    // profiles — the health score degrades gracefully rather than throwing.
    const payload = await getBaselineProfiles(orgId, state.installId);
    if (payload) profiles.push(...payload);
  }

  return { profiles, lines };
}

/**
 * Build the `AnalysisContext` from REAL tracked inputs (#4514 AC4). Shared by the
 * health endpoint and the briefing so the health score and the analyzer's
 * findings read the same state.
 *
 * `opts.profiles` lets the briefing loader thread the profiles it already loaded
 * (with freshness) so they aren't fetched twice; omit it and the context loads
 * the tracked profile payload itself.
 */
export async function loadAnalysisContext(
  orgId: string | null,
  mode: EntityMode = "published",
  opts: { profiles?: TableProfile[] } = {},
): Promise<{ ctx: AnalysisContext; totalRows: number; parseFailures: number }> {
  const { loadEntitiesForOrg, loadEntitiesFromDisk, loadGlossaryFromDisk, loadAuditPatterns, loadRejectedKeys } =
    await import("./context-loader");
  const { hasInternalDB } = await import("@atlas/api/lib/db/internal");

  let entities: AnalysisContext["entities"];
  let parseFailures = 0;
  let totalRows: number;
  if (orgId && hasInternalDB()) {
    const dbResult = await loadEntitiesForOrg(orgId, mode);
    entities = dbResult.entities;
    parseFailures = dbResult.parseFailures;
    totalRows = dbResult.totalRows;
  } else {
    entities = await loadEntitiesFromDisk();
    totalRows = entities.length;
  }

  const glossary = await loadGlossaryFromDisk();
  const auditPatterns = await loadAuditPatterns(orgId ?? undefined);
  const rejectedKeys = await loadRejectedKeys(orgId ?? undefined);
  const profiles = opts.profiles ?? (await loadTrackedProfiles(orgId, new Date())).profiles;

  return {
    ctx: { profiles, entities, glossary, auditPatterns, rejectedKeys },
    totalRows,
    parseFailures,
  };
}

/** Pull a string field from an untyped amendment payload. */
function payloadStr(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key];
  return typeof v === "string" ? v : null;
}

/**
 * Gather everything the pure `assembleBriefing` needs for one turn. `now` is
 * injected for deterministic freshness. Reads only tracked/internal data — no
 * customer-database query (#4514 AC3).
 */
export async function loadBriefingInputs(orgId: string | null, now: Date = new Date()): Promise<BriefingInputs> {
  const { profiles, lines } = await loadTrackedProfiles(orgId, now);
  const { ctx, totalRows, parseFailures } = await loadAnalysisContext(orgId, "published", { profiles });

  const health = computeSemanticHealth(ctx);
  const healthStatus = deriveHealthStatus(parseFailures, totalRows, ctx.entities.length);
  const findings = analyzeSemanticLayer(ctx);

  const { getPendingAmendments, getRecentlyDecidedAmendments } = await import("@atlas/api/lib/db/internal");
  const [pendingRows, decidedRows] = await Promise.all([
    getPendingAmendments(orgId),
    getRecentlyDecidedAmendments(orgId, 10),
  ]);

  const pending = pendingRows.map((row) => ({
    entityName: row.source_entity,
    amendmentType: payloadStr(row.amendment_payload, "amendmentType"),
    confidence: typeof row.confidence === "number" ? row.confidence : 0,
    rationale: payloadStr(row.amendment_payload, "rationale") ?? row.description,
  }));

  const recentDecisions = decidedRows.map((row) => ({
    entityName: row.source_entity,
    amendmentType: payloadStr(row.amendment_payload, "amendmentType"),
    decision: row.status,
  }));

  return {
    health,
    healthStatus,
    parseFailures,
    totalRows,
    profiles: lines,
    findings,
    auditPatterns: ctx.auditPatterns,
    pending,
    recentDecisions,
    rejectionMemoryCount: ctx.rejectedKeys.size,
  };
}

/**
 * Load + assemble the briefing block for a workspace, fail-soft. Returns the
 * rendered block, or `null` when it can't be built (no data yet, or a transient
 * load failure) — the improve chat must still start without it, just without the
 * front-loaded context. Never throws.
 */
export async function buildBriefingBlock(orgId: string | null, now: Date = new Date()): Promise<string | null> {
  try {
    const { assembleBriefing } = await import("./briefing");
    const inputs = await loadBriefingInputs(orgId, now);
    return assembleBriefing(inputs);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to assemble semantic-improve briefing — starting the chat without front-loaded context",
    );
    return null;
  }
}
