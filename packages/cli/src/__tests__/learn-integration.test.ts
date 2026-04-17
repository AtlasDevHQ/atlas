/**
 * Integration test for `handleLearn` — asserts that CLI arguments wire
 * through to `generateSuggestions` with the correct `autoApprove` flag.
 *
 * Covers acceptance criterion from #1482: "Integration test: run atlas
 * learn against a test layer, assert pending rows exist." The unit tests
 * separately verify that `upsertSuggestion` writes `pending`/`draft` by
 * default and `approved`/`published` under `autoApprove`; this test fills
 * the remaining gap by exercising the full CLI → generateSuggestions
 * call path so a regression in the CLI's flag parsing (e.g. forgetting
 * to thread `autoApprove` into the options object) would be caught.
 *
 * The test stands up a temporary `semantic/entities/` directory with a
 * minimal entity YAML so `loadEntities()` succeeds; the internal DB is
 * mocked to return synthetic audit rows; `generateSuggestions` is
 * replaced with a recorder that captures the options it was called with.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// --- Temp workspace must exist BEFORE cli-utils resolves SEMANTIC_DIR. ---
// SEMANTIC_DIR = path.resolve("semantic") is computed at module load, so
// chdir happens before the handleLearn import below.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-learn-integration-"));
const entitiesDir = path.join(tmpRoot, "semantic", "entities");
fs.mkdirSync(entitiesDir, { recursive: true });
fs.writeFileSync(
  path.join(entitiesDir, "users.yml"),
  `table: users
description: Users
dimensions:
  - name: id
    sql: id
    type: string
`,
);

const origCwd = process.cwd();
process.chdir(tmpRoot);

const origDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas_test";

// --- Recorder for generateSuggestions invocations. ---
const generateSuggestionsCalls: Array<{ orgId: string | null; autoApprove: boolean | undefined }> = [];

// --- Mock modules used by handleLearn via dynamic import. ---
// The internal DB stub pool returns synthetic audit rows so fetchAuditLog
// yields non-empty output (otherwise handleLearn short-circuits before
// reaching the --suggestions branch).
mock.module("@atlas/api/lib/db/internal", () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          sql: "SELECT id FROM users WHERE id = $1",
          row_count: 1,
          tables_accessed: ["users"],
          columns_accessed: ["id"],
          timestamp: "2026-04-10T00:00:00Z",
        },
        {
          sql: "SELECT id FROM users WHERE id = $1",
          row_count: 1,
          tables_accessed: ["users"],
          columns_accessed: ["id"],
          timestamp: "2026-04-10T01:00:00Z",
        },
      ],
    }),
    async end() {},
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    on() {},
  };
  return {
    hasInternalDB: () => true,
    getInternalDB: () => pool,
    closeInternalDB: async () => {},
    internalQuery: async () => [],
    internalExecute: () => {},
  };
});

mock.module("@atlas/api/lib/learn/suggestions", () => ({
  generateSuggestions: async (
    orgId: string | null,
    options: { autoApprove?: boolean } = {},
  ) => {
    generateSuggestionsCalls.push({ orgId, autoApprove: options.autoApprove });
    return { created: 1, updated: 0, skipped: 0 };
  },
}));

// Import AFTER chdir + env + mocks.
const { handleLearn } = await import("../commands/learn");

beforeAll(() => {
  // Silence console output during the suite so CI logs stay clean.
  // Errors from process.exit are still thrown and caught per-test.
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = origLog;
    console.error = origErr;
  };
});

afterAll(() => {
  process.chdir(origCwd);
  if (origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = origDatabaseUrl;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  mock.restore();
});

beforeEach(() => {
  generateSuggestionsCalls.length = 0;
});

describe("handleLearn — CLI to generateSuggestions wire-through", () => {
  it("passes autoApprove=false to generateSuggestions when only --suggestions is supplied", async () => {
    await handleLearn(["--suggestions"]);
    expect(generateSuggestionsCalls).toHaveLength(1);
    expect(generateSuggestionsCalls[0]).toEqual({ orgId: null, autoApprove: false });
  });

  it("passes autoApprove=true to generateSuggestions when --suggestions --auto-approve is supplied", async () => {
    await handleLearn(["--suggestions", "--auto-approve"]);
    expect(generateSuggestionsCalls).toHaveLength(1);
    expect(generateSuggestionsCalls[0]).toEqual({ orgId: null, autoApprove: true });
  });
});
