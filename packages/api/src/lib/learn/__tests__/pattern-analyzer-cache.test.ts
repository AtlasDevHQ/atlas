/**
 * Tests for the YAML pattern dedup cache TTL + invalidation (#3614).
 *
 * `getYamlPatterns()` caches the normalized `query_patterns` SQL from entity
 * YAMLs so `proposePatternIfNovel` can suppress re-proposing patterns that are
 * already authored in the semantic layer. The cache used to live for the
 * process lifetime, so an admin adding a `query_patterns` entry kept getting
 * duplicate `learned_patterns` rows until the API restarted. The cache now has
 * a 5-minute TTL AND is actively dropped when the semantic index is
 * invalidated.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getYamlPatterns,
  invalidateYamlPatternCache,
  _resetYamlPatternCache,
  normalizeSQL,
} from "../pattern-analyzer";
import { invalidateSemanticIndex } from "@atlas/api/lib/semantic/search";
import { _analyzeAndPropose, type PatternProposalInput } from "../pattern-proposer";
import { _resetPool, type InternalPool } from "../../db/internal";

const PATTERN_A_SQL = "SELECT plan, SUM(monthly_value) AS total_mrr FROM accounts GROUP BY plan";
const PATTERN_B_SQL = "SELECT region, COUNT(*) AS account_count FROM accounts GROUP BY region";

let tmpRoot: string;
const origSemanticRoot = process.env.ATLAS_SEMANTIC_ROOT;

/** Build an entity YAML with the given `query_patterns` SQL list. */
function entityYaml(patternSqls: string[]): string {
  if (patternSqls.length === 0) return "table: accounts\n";
  const patterns = patternSqls
    .map((sql, i) => `  - name: p${i}\n    sql: "${sql}"`)
    .join("\n");
  return `table: accounts\nquery_patterns:\n${patterns}\n`;
}

/** Write the entity YAML into the temp semantic root's `entities/` dir. */
function writeAccountsEntity(patternSqls: string[]): void {
  const entitiesDir = path.join(tmpRoot, "entities");
  fs.mkdirSync(entitiesDir, { recursive: true });
  fs.writeFileSync(path.join(entitiesDir, "accounts.yml"), entityYaml(patternSqls), "utf-8");
}

describe("YAML pattern cache TTL + invalidation (#3614)", () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-pattern-cache-"));
    process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
    _resetYamlPatternCache();
  });

  afterEach(() => {
    _resetYamlPatternCache();
    if (origSemanticRoot === undefined) {
      delete process.env.ATLAS_SEMANTIC_ROOT;
    } else {
      process.env.ATLAS_SEMANTIC_ROOT = origSemanticRoot;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("caches within the TTL window — a YAML edit is not seen until reload", () => {
    writeAccountsEntity([PATTERN_A_SQL]);

    const first = getYamlPatterns();
    expect(first.has(normalizeSQL(PATTERN_A_SQL))).toBe(true);
    expect(first.has(normalizeSQL(PATTERN_B_SQL))).toBe(false);

    // Admin appends a new query pattern to the entity YAML.
    writeAccountsEntity([PATTERN_A_SQL, PATTERN_B_SQL]);

    // Still served from cache — the new pattern is not visible yet. This is the
    // bug surface: without invalidation/TTL the cache would stay stale forever.
    expect(getYamlPatterns().has(normalizeSQL(PATTERN_B_SQL))).toBe(false);
  });

  test("invalidateSemanticIndex drops the cache so new patterns are reflected", () => {
    writeAccountsEntity([PATTERN_A_SQL]);
    getYamlPatterns(); // populate cache

    writeAccountsEntity([PATTERN_A_SQL, PATTERN_B_SQL]);

    // Mutating the in-memory semantic layer fires invalidateSemanticIndex,
    // which must also drop the derived YAML pattern cache.
    invalidateSemanticIndex();

    const after = getYamlPatterns();
    expect(after.has(normalizeSQL(PATTERN_A_SQL))).toBe(true);
    expect(after.has(normalizeSQL(PATTERN_B_SQL))).toBe(true);
  });

  test("invalidateYamlPatternCache forces a re-read on the next call", () => {
    writeAccountsEntity([PATTERN_A_SQL]);
    getYamlPatterns(); // populate cache

    writeAccountsEntity([PATTERN_A_SQL, PATTERN_B_SQL]);
    invalidateYamlPatternCache();

    expect(getYamlPatterns().has(normalizeSQL(PATTERN_B_SQL))).toBe(true);
  });

  test("TTL backstop: cache expires after the window without explicit invalidation", () => {
    let now = 1_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      writeAccountsEntity([PATTERN_A_SQL]);
      getYamlPatterns(); // cached at t=1_000_000, expires at +5min

      writeAccountsEntity([PATTERN_A_SQL, PATTERN_B_SQL]);

      // Within the 5-minute window → still stale.
      now += 4 * 60 * 1000;
      expect(getYamlPatterns().has(normalizeSQL(PATTERN_B_SQL))).toBe(false);

      // Past the TTL → re-reads from disk even though nothing called invalidate.
      now += 2 * 60 * 1000;
      expect(getYamlPatterns().has(normalizeSQL(PATTERN_B_SQL))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("empty results are not cached so a not-yet-synced root retries", () => {
    // No entities/ dir yet → empty result, must not be pinned.
    expect(getYamlPatterns().size).toBe(0);

    writeAccountsEntity([PATTERN_A_SQL]);
    expect(getYamlPatterns().has(normalizeSQL(PATTERN_A_SQL))).toBe(true);
  });

  test("proposePatternIfNovel suppresses a pattern added after invalidation — no duplicate row (#3614)", async () => {
    const origDbUrl = process.env.DATABASE_URL;
    const queryCalls: Array<{ sql: string }> = [];
    const mockPool: InternalPool = {
      query: async (sql: string) => {
        queryCalls.push({ sql });
        return { rows: [] };
      },
      async connect() {
        return { query: async () => ({ rows: [] }), release() {} };
      },
      end: async () => {},
      on: () => {},
    };
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);

    const input: PatternProposalInput = {
      sql: PATTERN_A_SQL,
      dialect: "PostgresQL",
      connectionId: "default",
      orgId: undefined,
      connectionGroupId: undefined,
    };

    try {
      // Entity has no query_patterns yet → the query is novel and gets proposed,
      // which touches the DB (SELECT + INSERT).
      writeAccountsEntity([]);
      await _analyzeAndPropose(input);
      expect(queryCalls.length).toBeGreaterThan(0);

      // Admin authors the pattern into the YAML; the semantic layer reloads.
      queryCalls.length = 0;
      writeAccountsEntity([PATTERN_A_SQL]);
      invalidateSemanticIndex();

      // Now the query matches a YAML pattern → suppressed before any DB write,
      // so no duplicate learned_patterns row is inserted.
      await _analyzeAndPropose(input);
      expect(queryCalls.length).toBe(0);
    } finally {
      if (origDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = origDbUrl;
      }
      _resetPool(null);
    }
  });
});
