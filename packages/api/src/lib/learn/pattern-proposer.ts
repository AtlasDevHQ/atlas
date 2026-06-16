/**
 * Fire-and-forget pattern proposal after successful SQL execution.
 *
 * Analyzes executed queries for novelty and proposes them as learned
 * patterns when they don't match existing YAML query_patterns or
 * learned_patterns rows.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, findPatternBySQL, insertLearnedPattern, incrementPatternCount } from "@atlas/api/lib/db/internal";
import { normalizeSQL, fingerprintSQL, extractPatternInfo, getYamlPatterns } from "@atlas/api/lib/learn/pattern-analyzer";

const log = createLogger("pattern-proposer");

export interface PatternProposalInput {
  sql: string;
  dialect: string;
  /** Used for debug logging only; not stored in the learned pattern record. */
  connectionId: string;
  /**
   * Owning org for the learned pattern. MUST be captured synchronously at the
   * `sql.ts` call site while the request's AsyncLocalStorage context is still
   * live (#3610). This proposal runs fire-and-forget AFTER the originating
   * request has unwound, so reading `orgId` from ALS in here would resolve to
   * `undefined` and write `org_id = NULL` — the global-scope sentinel — leaking
   * one org's SQL patterns into every org's agent context.
   */
  orgId: string | null | undefined;
  /**
   * Connection group the query ran against (#3611). Captured synchronously
   * alongside `orgId`. Scopes the pattern so `us-prod` patterns don't leak into
   * a `eu-prod` agent session and identical SQL from a different group is not
   * deduped away.
   */
  connectionGroupId: string | null | undefined;
}

/**
 * Analyze a successfully-executed query and propose it as a learned pattern if novel.
 * Fire-and-forget: errors are logged but never thrown.
 */
export function proposePatternIfNovel(input: PatternProposalInput): void {
  if (!hasInternalDB()) return;

  void _analyzeAndPropose(input).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), sql: input.sql.slice(0, 200) },
      "Pattern proposal analysis failed — learned patterns may not be recording",
    );
  });
}

/**
 * Core analysis logic. Exported for testing.
 * @internal
 */
export async function _analyzeAndPropose(input: PatternProposalInput): Promise<void> {
  const { sql, dialect, connectionId, orgId, connectionGroupId } = input;

  // 1. Normalize SQL for dedup
  const normalized = normalizeSQL(sql);
  if (!normalized || normalized.length < 10) return;

  // 2. Check against YAML query_patterns
  const yamlPatterns = getYamlPatterns();
  if (yamlPatterns.has(normalized)) {
    log.debug({ sql: sql.slice(0, 100) }, "Query matches existing YAML pattern — skipping proposal");
    return;
  }

  // 3. Check against learned_patterns table. `orgId`/`connectionGroupId` were
  // captured synchronously at the call site (#3610/#3611) — never read from ALS
  // here, the request context has already unwound by the time this runs.
  const fingerprint = fingerprintSQL(normalized);

  const existing = await findPatternBySQL(orgId, connectionGroupId, normalized);
  if (existing) {
    // Duplicate — bump count and confidence, append source fingerprint
    incrementPatternCount(existing.id, fingerprint);
    log.debug(
      { patternId: existing.id, newCount: existing.repetitionCount + 1 },
      "Incremented repetition count for existing learned pattern",
    );
    return;
  }

  // 4. Novel pattern — extract metadata and insert
  const info = extractPatternInfo(sql, dialect);

  insertLearnedPattern({
    orgId,
    connectionGroupId,
    patternSql: normalized,
    description: info?.description ?? "Query pattern",
    sourceEntity: info?.primaryTable ?? "unknown",
    sourceQueries: [fingerprint],
    proposedBy: "agent",
  });

  log.debug(
    { primaryTable: info?.primaryTable, fingerprint, connectionId, connectionGroupId },
    "Proposed novel learned pattern",
  );
}
