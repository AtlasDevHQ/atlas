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
import type { BriefingInputs, BriefingProfileLine, SemanticHealthStatus } from "./briefing";
import { resolveBriefingAnchor, type ImproveAnchor } from "./anchor";

const log = createLogger("semantic-expert-briefing");

/** Read mode for the entity source — published (admin default) or developer overlay. */
type EntityMode = "published" | "developer";

/**
 * The health status discriminator: a parse-failure zero ("corrupt") is not the
 * same as a no-data zero ("no_entities"). Shared by the health endpoint and the
 * briefing so both read the SAME rule. `corrupt` gates on `totalRows`
 * (DB-rows-considered) so a healthy disk mirror can't mask the corruption; empty
 * gates on the merged `entityCount` (#2503).
 *
 * The three args are same-typed and NOT interchangeable — order is
 * (parseFailures, totalRows, entityCount); pass them from a single load result
 * (`loadAnalysisContext` + `ctx.entities.length`) so they can't be transposed.
 */
export function deriveHealthStatus(
  parseFailures: number,
  totalRows: number,
  entityCount: number,
): SemanticHealthStatus {
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

  // Anchor lines are pure (freshness pre-computed against injected `now`).
  const lines: BriefingProfileLine[] = states.map((state) => {
    const freshness = describeProfileFreshness(state.baseline?.profiledAt ?? null, now);
    return {
      connection: state.installId,
      dbType: state.dbType,
      freshness: freshness?.label ?? null,
      tableCount: state.baseline?.tableCount ?? null,
    };
  });

  // Fetch each connection's stored baseline payload in parallel — the reads are
  // independent (no async waterfall). A connection with only a FAILED baseline
  // (payload null) contributes an anchor line but no profiles, so the health
  // score degrades gracefully rather than throwing. `flatMap` preserves order.
  const payloads = await Promise.all(states.map((state) => getBaselineProfiles(orgId, state.installId)));
  const profiles: TableProfile[] = payloads.flatMap((p) => p ?? []);

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
 *
 * `anchor` (#4519) scopes the briefing: it is resolved PURELY against the same
 * entities + profiles already loaded here (no extra I/O). A group anchor
 * front-loads its entity inventory; an entity anchor front-loads its YAML +
 * profile. Omit it for an anchorless sweep — the briefing is then byte-identical
 * to the pre-anchor block.
 */
export async function loadBriefingInputs(
  orgId: string | null,
  now: Date = new Date(),
  anchor?: ImproveAnchor,
): Promise<BriefingInputs> {
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

  // Resolve the anchor from the entities + profiles already in hand — no extra
  // read. An entity anchor whose target isn't in scope resolves to null; the
  // briefing then starts unanchored rather than fabricating the entity. That
  // degrade is deliberate but must NOT be silent (the launcher can offer an
  // entity the published briefing can't see — e.g. a draft-only entity in
  // developer mode, or a group-id namespace mismatch): log it so "anchoring
  // silently didn't scope" is greppable rather than undebuggable. A group anchor
  // never returns null (an empty group renders its own explicit line), so only
  // the entity-miss path reaches this warn.
  const resolvedAnchor = anchor ? resolveBriefingAnchor(anchor, ctx.entities, ctx.profiles) : null;
  if (anchor && !resolvedAnchor) {
    log.warn(
      { orgId, anchorKind: anchor.kind, anchorName: anchor.kind === "entity" ? anchor.entity : anchor.group },
      "Improve anchor did not resolve against the published semantic layer — briefing starts unanchored",
    );
  }

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
    anchor: resolvedAnchor ?? undefined,
  };
}

/**
 * Load + assemble the briefing block for a workspace, fail-soft. Returns the
 * rendered block, or `null` ONLY on a load failure (a DB read throwing, etc.) —
 * the empty-workspace case still renders a valid block ("no entities", "queue
 * empty"), so `null` is strictly the error path. On `null` the improve chat must
 * still start, just without the front-loaded context. Never throws.
 *
 * The catch logs the whole `Error` (not just its message) so Pino's serializer
 * keeps the stack — this is the sole observability seam for a per-turn
 * optimization that otherwise degrades silently; matching the stream handler in
 * admin-semantic-improve.ts.
 */
export async function buildBriefingBlock(
  orgId: string | null,
  now: Date = new Date(),
  anchor?: ImproveAnchor,
): Promise<string | null> {
  try {
    const { assembleBriefing } = await import("./briefing");
    const inputs = await loadBriefingInputs(orgId, now, anchor);
    return assembleBriefing(inputs);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), orgId },
      "Failed to assemble semantic-improve briefing — starting the chat without front-loaded context",
    );
    return null;
  }
}
