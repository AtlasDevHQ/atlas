/**
 * The canonical-eval CLI's exit code, observed from the shell (#5130).
 *
 * ⚠️ EVERY TEST HERE SPAWNS THE CLI AND READS THE PROCESS EXIT CODE. That is
 * the whole point, and it is not interchangeable with asserting a function's
 * return value. The bug this file locks down was invisible to a return-value
 * test: `runMcpLlmMode` returned 1 exactly as designed, the acceptance floor was
 * computed and printed — and then an early `return` inside the staging
 * `try`/`finally` left the function before `process.exit(exitCode)`, so the
 * process ended on its natural code, 0. A 12/20 shipped as a green CI check.
 *
 * The sandbox is a throwaway cwd, because `canonical-eval-run.ts` resolves both
 * `semantic/` and the seed fixture root from `process.cwd()` at module load. A
 * spawn rooted in a tmpdir therefore stages, backs up, and restores entirely
 * inside that tmpdir and cannot touch the repo's own `semantic/`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "bin", "atlas.ts");
const PRELOAD = path.join(
  import.meta.dir,
  "fixtures",
  "canonical-eval-exit-code.preload.ts",
);

/**
 * Port 1 is reserved and never listening, so `seedDemoPostgres` fails with a
 * fast ECONNREFUSED rather than a connect timeout.
 */
const DEAD_DATASOURCE_URL = "postgres://atlas:atlas@127.0.0.1:1/atlas_demo";

/** Mirrors `BACKUP_DIR` in `canonical-eval-run.ts`, which is cwd-relative. */
const BACKUP_DIR_NAME = ".semantic-backup-canonical-eval";

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A cwd the CLI can stage into: a seed fixture for `--schema ecommerce` plus a
 * pre-existing `semantic/`. The pre-existing layer is load-bearing for the
 * restore tests — with no `semantic/` there is nothing to back up, and
 * `restoreSemanticLayer` short-circuits to success before it can fail.
 */
function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-eval-exit-"));
  sandboxes.push(dir);

  const seedEntities = path.join(
    dir,
    "packages",
    "cli",
    "data",
    "seeds",
    "ecommerce",
    "semantic",
    "entities",
  );
  fs.mkdirSync(seedEntities, { recursive: true });
  fs.writeFileSync(
    path.join(seedEntities, "orders.yml"),
    "name: orders\ntable: orders\n",
  );

  const originalEntities = path.join(dir, "semantic", "entities");
  fs.mkdirSync(originalEntities, { recursive: true });
  fs.writeFileSync(
    path.join(originalEntities, "mine.yml"),
    "name: mine\ntable: mine\n",
  );

  return dir;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCanonicalEval(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const needsPreload =
    extraEnv.ATLAS_TEST_STUB_SEED !== undefined ||
    extraEnv.ATLAS_TEST_FAIL_RM_PATH !== undefined;

  const proc = Bun.spawn(
    [
      process.execPath,
      ...(needsPreload ? ["--preload", PRELOAD] : []),
      CLI_ENTRY,
      "canonical-eval",
      ...args,
    ],
    {
      cwd,
      // Built from scratch rather than spread from `process.env` so an
      // ANTHROPIC_API_KEY in the developer's shell cannot change which branch
      // the `--mcp-llm` test lands on.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ATLAS_DATASOURCE_URL: DEAD_DATASOURCE_URL,
        ATLAS_DEPLOY_MODE: "self-hosted",
        ATLAS_DEPLOY_ENV: "development",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("canonical-eval process exit code", () => {
  test(
    "a demo-seed failure exits 1 in deterministic mode",
    async () => {
      const { exitCode, stderr } = await runCanonicalEval(makeSandbox(), []);

      // The message alone was never the bug — it printed correctly throughout.
      // Assert it only to prove the run reached the seed catch rather than
      // dying somewhere else with a coincidentally non-zero code.
      expect(stderr).toContain("failed to seed demo Postgres");
      expect(exitCode).toBe(1);
    },
    120_000,
  );

  test(
    "a demo-seed failure exits 1 in --mcp-llm mode",
    async () => {
      const { exitCode, stderr } = await runCanonicalEval(makeSandbox(), [
        "--mcp-llm",
      ]);

      expect(stderr).toContain("failed to seed demo Postgres");
      expect(exitCode).toBe(1);
    },
    120_000,
  );

  test(
    "--mcp-llm hands the mode's own non-zero code to the shell",
    async () => {
      // Seed stubbed so the run gets past it without a live Postgres; the
      // provider key deliberately absent so `runMcpLlmMode` returns 1 the same
      // way a below-floor score does. What is under test is that ANY non-zero
      // it returns survives the assignment-then-return at the mcp-llm branch.
      const { exitCode, stderr } = await runCanonicalEval(
        makeSandbox(),
        ["--mcp-llm"],
        {
          ATLAS_TEST_STUB_SEED: "1",
          ATLAS_PROVIDER: "anthropic",
          ATLAS_MODEL: "claude-sonnet-4-5",
        },
      );

      expect(stderr).toContain("--mcp-llm requires");
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  test(
    "a restore failure outranks the eval failure — exit 2, not 1",
    async () => {
      const sandbox = makeSandbox();
      const { exitCode, stderr } = await runCanonicalEval(sandbox, [], {
        ATLAS_TEST_FAIL_RM_PATH: path.join(sandbox, BACKUP_DIR_NAME),
      });

      // Both halves must be present: the body earned 1 (seed failure) and the
      // finally bumped it to 2. Asserting 2 against a run that also earns 1
      // keeps the three outcomes this file cares about — 0, 1, 2 — distinct, so
      // the assertion cannot pass by accidental equality.
      expect(stderr).toContain("failed to seed demo Postgres");
      expect(stderr).toContain("Failed to restore semantic layer");
      expect(exitCode).toBe(2);
    },
    120_000,
  );
});
