/**
 * Query suggestion analysis engine.
 *
 * Reads the audit log, groups queries by normalized SQL fingerprint,
 * scores by frequency + recency, and upserts into query_suggestions.
 * Idempotent via INSERT … ON CONFLICT DO UPDATE.
 */

import { normalizeSQL, fingerprintSQL, extractPatternInfo, getYamlPatterns } from "@atlas/api/lib/learn/pattern-analyzer";
import { getAuditLogQueries, upsertSuggestion } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("suggestions");

const MIN_PATTERN_COUNT = 2;

// ── Scoring ────────────────────────────────────────────────────────

/** Score a suggestion by frequency weighted by recency (30-day half-life). */
export function scoreSuggestion(frequency: number, lastSeenAt: Date): number {
  const daysSince = (Date.now() - lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
  return frequency * (1 / (1 + daysSince / 30));
}

// ── Grouping ───────────────────────────────────────────────────────

interface AuditRow {
  sql: string;
  tables_accessed: string | null;
  timestamp: string;
}

export interface GroupedPattern {
  normalizedSql: string;
  fingerprint: string;
  count: number;
  lastSeen: Date;
  tables: string[];
  primaryTable: string | null;
  description: string;
}

/** Group audit rows by normalized SQL fingerprint. Exported for testing only. */
export function _groupAuditRows(rows: AuditRow[]): Map<string, GroupedPattern> {
  const groups = new Map<string, GroupedPattern>();

  for (const row of rows) {
    if (!row.sql) continue;
    const normalized = normalizeSQL(row.sql);
    if (!normalized) continue;
    const fp = fingerprintSQL(normalized);

    const existing = groups.get(fp);
    const rowTime = new Date(row.timestamp);

    if (existing) {
      existing.count++;
      if (rowTime > existing.lastSeen) {
        existing.lastSeen = rowTime;
      }
    } else {
      const info = extractPatternInfo(row.sql);
      let tables: string[] = [];
      try {
        tables = row.tables_accessed ? JSON.parse(row.tables_accessed) : [];
      } catch {
        // intentionally ignored: malformed tables_accessed JSON
      }
      if (tables.length === 0 && info?.tables) {
        tables = info.tables;
      }

      groups.set(fp, {
        normalizedSql: normalized,
        fingerprint: fp,
        count: 1,
        lastSeen: rowTime,
        tables,
        primaryTable: info?.primaryTable ?? tables[0] ?? null,
        description: info?.description ?? "Query pattern",
      });
    }
  }

  return groups;
}

// ── Batch generation ───────────────────────────────────────────────

/**
 * Options for batch suggestion generation.
 *
 * `autoApprove` is threaded down to `upsertSuggestion`. The default is
 * `false` (pending / draft) so CLI-populated rows land in the admin
 * moderation queue — matching the organic click-promoted path. Operators
 * who want to skip review in self-hosted deployments pass `true` via
 * `atlas learn --auto-approve`.
 */
export interface GenerateSuggestionsOptions {
  readonly autoApprove?: boolean;
}

/**
 * Summary returned from a batch generation run. `skipped` counts upserts
 * that `upsertSuggestion` swallowed (internal-DB unavailable, constraint
 * violation, connection drop — see that function's catch). The CLI reads
 * `skipped` to distinguish a silent no-op from a successful run; when
 * `autoApprove` is set, any non-zero `skipped` is a policy violation
 * because the operator asked for explicit publication.
 */
export interface GenerateSuggestionsResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

/** Batch-generate suggestions from audit log. Idempotent via upsert. */
export async function generateSuggestions(
  orgId: string | null,
  options: GenerateSuggestionsOptions = {}
): Promise<GenerateSuggestionsResult> {
  const rows = await getAuditLogQueries(orgId);
  if (rows.length === 0) {
    log.info({ orgId }, "No audit log entries found for suggestion generation");
    return { created: 0, updated: 0, skipped: 0 };
  }

  const groups = _groupAuditRows(rows);

  // Filter: drop low-frequency patterns
  const candidates = [...groups.values()].filter((g) => g.count >= MIN_PATTERN_COUNT);

  // Filter: drop patterns that exist in YAML query_patterns
  let yamlPatterns: Set<string> | null = null;
  try {
    yamlPatterns = getYamlPatterns();
  } catch {
    // intentionally ignored: YAML patterns unavailable (SaaS mode)
  }

  const filtered = yamlPatterns
    ? candidates.filter((c) => !yamlPatterns!.has(c.normalizedSql))
    : candidates;

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const autoApprove = options.autoApprove === true;

  for (const pattern of filtered) {
    const score = scoreSuggestion(pattern.count, pattern.lastSeen);
    const result = await upsertSuggestion({
      orgId,
      description: pattern.description,
      patternSql: pattern.normalizedSql,
      normalizedHash: pattern.fingerprint,
      tablesInvolved: pattern.tables,
      primaryTable: pattern.primaryTable,
      frequency: pattern.count,
      score,
      lastSeenAt: pattern.lastSeen,
      autoApprove,
    });
    if (result === "created") created++;
    else if (result === "updated") updated++;
    else skipped++;
  }

  log.info(
    { orgId, created, updated, skipped, total: filtered.length, autoApprove },
    "Suggestion generation complete"
  );
  return { created, updated, skipped };
}
