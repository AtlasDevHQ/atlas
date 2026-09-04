/**
 * `handleLearn` — the `atlas-operator learn` command handler.
 *
 * Two blocks: the `--auto-approve` argument guard (formerly `learn.test.ts`),
 * and the CLI → `generateSuggestions` wire-through. They share this file's
 * mocked internal DB and `generateSuggestions` recorder; the guard exits before
 * either is reached, so the mocks are inert for it.
 *
 * The wire-through half asserts that CLI arguments reach
 * `generateSuggestions` with the correct `autoApprove` flag.
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
 *
 * Self-containment (#2798, milestone 1.5.4): all OS-level setup —
 * tmpdir, chdir, env, mock.module, dynamic import — runs inside
 * `beforeAll` so this file's worker doesn't bleed cwd / env into sibling
 * test files under native `bun test --parallel`. `SEMANTIC_DIR =
 * path.resolve("semantic")` resolves at the dynamic import below, so
 * the chdir-then-import ordering inside the hook is load-bearing.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Hoisted bindings — populated in beforeAll once the OS state is set up.
let handleLearn: (typeof import("../commands/operator/learn"))["handleLearn"];
let tmpRoot: string;
let origCwd: string;
let origDatabaseUrl: string | undefined;

// Recorder for generateSuggestions invocations. Module-scoped so the
// mock.module factory (also hoisted inside beforeAll) and the test
// bodies share the same array.
const generateSuggestionsCalls: Array<{ orgId: string | null; autoApprove: boolean | undefined }> = [];

beforeAll(async () => {
  // Temp workspace must exist before cli-utils resolves SEMANTIC_DIR
  // (computed at module load via path.resolve("semantic")), so the
  // setup-chdir-mock-import ordering inside this hook is load-bearing.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-learn-integration-"));
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

  origCwd = process.cwd();
  process.chdir(tmpRoot);

  origDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas_test";

  // Mock modules used by handleLearn via dynamic import. The internal
  // DB stub pool returns synthetic audit rows so fetchAuditLog yields
  // non-empty output (otherwise handleLearn short-circuits before
  // reaching the --suggestions branch).
  void mock.module("@atlas/api/lib/db/internal", () => {
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

  void mock.module("@atlas/api/lib/learn/suggestions", () => ({
    generateSuggestions: async (
      orgId: string | null,
      options: { autoApprove?: boolean } = {},
    ) => {
      generateSuggestionsCalls.push({ orgId, autoApprove: options.autoApprove });
      return { created: 1, updated: 0, skipped: 0 };
    },
  }));

  // Import AFTER chdir + env + mocks.
  ({ handleLearn } = await import("../commands/operator/learn"));
});

// Silence console output during the suite so CI logs stay clean.
// Errors from process.exit are still thrown and caught per-test.
// Bun's `beforeAll` does NOT execute a returned cleanup function (unlike
// React's `useEffect`); only `afterAll` does. Capture originals at module
// scope and restore in the existing afterAll below — otherwise under the
// eventual `bun test --parallel` cutover (#2802) the muting would leak
// across sibling files in the same worker (post-#2813 code-review fix).
const origConsoleLog = console.log;
const origConsoleErr = console.error;
beforeAll(() => {
  console.log = () => {};
  console.error = () => {};
});

afterAll(() => {
  console.log = origConsoleLog;
  console.error = origConsoleErr;
  if (origCwd) process.chdir(origCwd);
  if (origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = origDatabaseUrl;
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
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

/**
 * The `--auto-approve` flag only affects query-suggestion rows, so it must be
 * combined with `--suggestions`. Without this guard, an operator could pass
 * `atlas-operator learn --auto-approve` expecting rows to be published, and get
 * the YAML improvement path instead — with zero rows written.
 *
 * ⚠️ Hooks are describe-scoped ON PURPOSE. A file-level `afterEach` here would
 * also run after the wire-through tests below, and the original file's
 * `mock.restore()` would tear down this file's `mock.module` registrations
 * mid-suite. The console/exit capture is all this block needs.
 */
describe("handleLearn — --auto-approve guard", () => {
  const errors: string[] = [];
  const origExit = process.exit;
  let exitCode: number | null = null;
  // The file mutes `console.error` in `beforeAll`; capture whatever is
  // installed at that point and put it back, rather than un-muting the suite.
  let mutedConsoleError: typeof console.error;

  beforeEach(() => {
    errors.length = 0;
    exitCode = null;
    mutedConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    // Cast via unknown so TypeScript accepts the thrower signature — the
    // production exit() never returns either, so behaviorally this is
    // equivalent. We catch the thrown sentinel in each test.
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__process_exit__:${exitCode}`);
    }) as unknown as typeof process.exit;
  });

  afterEach(() => {
    console.error = mutedConsoleError;
    process.exit = origExit;
  });

  it("exits 1 when --auto-approve is passed without --suggestions", async () => {
    let caught: Error | null = null;
    try {
      await handleLearn(["--auto-approve"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(exitCode).toBe(1);
    // The error message must tell the operator WHY the command failed —
    // a generic "invalid arguments" would hide the coupling between
    // --auto-approve and --suggestions.
    expect(errors.some((line) => line.includes("--auto-approve") && line.includes("--suggestions"))).toBe(true);
  });
});
