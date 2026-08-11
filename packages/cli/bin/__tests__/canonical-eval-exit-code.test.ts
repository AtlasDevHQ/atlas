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
 * ⚠️ THE EXIT-0 CASE IS LOAD-BEARING, not symmetry for its own sake. Without it
 * the suite says only "some runs are non-zero", which `process.exit(exitCode || 1)`
 * and an inverted `results.some(...)` ternary both satisfy — and a permanently
 * red canonical-eval blocks tag pushes via `scripts/eval-informational-gate.sh`.
 * The three exit codes this command can produce (0, 1, 2) are each asserted by
 * at least one test, so no assertion here can pass by accidental equality.
 *
 * The sandbox is a throwaway cwd, because `canonical-eval-run.ts` resolves both
 * `semantic/` and the seed fixture root from `process.cwd()` at module load. A
 * spawn rooted in a tmpdir therefore stages, backs up, and restores entirely
 * inside that tmpdir; the tests assert that directly rather than trusting it.
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

/**
 * Mirrors `BACKUP_DIR` in `canonical-eval-run.ts`, which is cwd-relative.
 * Duplicated rather than exported, and it fails safe: rename it in the source
 * and `ATLAS_TEST_FAIL_CP_FROM` matches nothing, the restore succeeds, and the
 * exit-2 test sees 1 instead of 2.
 */
const BACKUP_DIR_NAME = ".semantic-backup-canonical-eval";

const sandboxes: string[] = [];
const children: Array<{ kill: () => void }> = [];

afterEach(() => {
  // Kill first: `test-isolated.ts` awaits `proc.exited` with no per-file timer,
  // so a child that outlives its test would hang the whole file rather than
  // fail it.
  while (children.length > 0) {
    children.pop()?.kill();
  }
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
  // realpath, because the child computes BACKUP_DIR through `process.cwd()`,
  // which resolves symlinks. `os.tmpdir()` is behind `/private` on macOS, and
  // the exact-string path comparison in the preload would never match.
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "canonical-eval-exit-")),
  );
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

/** The caller's own `semantic/entities/mine.yml`, which restore must put back. */
function callersLayerPath(sandbox: string): string {
  return path.join(sandbox, "semantic", "entities", "mine.yml");
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly args?: string[];
  /**
   * Explicit rather than inferred from the presence of a switch in `env` — an
   * env switch added later would otherwise silently fail to be preloaded.
   */
  readonly preload?: boolean;
  readonly env?: Record<string, string>;
}

async function runCanonicalEval(
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const proc = Bun.spawn(
    [
      process.execPath,
      ...(options.preload === true ? ["--preload", PRELOAD] : []),
      CLI_ENTRY,
      "canonical-eval",
      ...(options.args ?? []),
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
        ...(options.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(proc);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * `bin/atlas.ts` ends `main().catch(...)` with `process.exit(1)`, so an
 * unrelated crash also reports 1. Every exit-1 assertion below pairs with this
 * so it cannot pass for that reason.
 */
function expectNoCrash(stderr: string): void {
  expect(stderr).not.toContain("canonical eval failed");
  expect(stderr).not.toContain("at handleCanonicalEval");
}

describe("canonical-eval process exit code", () => {
  test(
    "a demo-seed failure exits 1 in deterministic mode",
    async () => {
      const sandbox = makeSandbox();
      const { exitCode, stderr } = await runCanonicalEval(sandbox);

      // The message alone was never the bug — it printed correctly throughout.
      // Assert it only to prove the run reached the seed catch rather than
      // dying somewhere else with a coincidentally non-zero code.
      expect(stderr).toContain("failed to seed demo Postgres");
      expectNoCrash(stderr);
      expect(exitCode).toBe(1);
      // The `finally` still restored on the early-return path, and it restored
      // inside the sandbox rather than anywhere near the repo.
      expect(fs.existsSync(callersLayerPath(sandbox))).toBe(true);
      expect(fs.existsSync(path.join(sandbox, BACKUP_DIR_NAME))).toBe(false);
    },
    120_000,
  );

  test(
    "a demo-seed failure exits 1 in --mcp-llm mode",
    async () => {
      const sandbox = makeSandbox();
      const { exitCode, stderr } = await runCanonicalEval(sandbox, {
        args: ["--mcp-llm"],
      });

      expect(stderr).toContain("failed to seed demo Postgres");
      expectNoCrash(stderr);
      expect(exitCode).toBe(1);
      expect(fs.existsSync(callersLayerPath(sandbox))).toBe(true);
    },
    120_000,
  );

  test(
    "--mcp-llm hands the mode's own non-zero code to the shell",
    async () => {
      // Seed stubbed so the run gets past it without a live Postgres; the
      // provider key deliberately absent so `runMcpLlmMode` returns 1 the same
      // way a below-floor score does. What is under test is that ANY non-zero
      // it returns survives the `return await runMcpLlmMode(...)` branch.
      const { exitCode, stderr } = await runCanonicalEval(makeSandbox(), {
        args: ["--mcp-llm"],
        preload: true,
        env: {
          ATLAS_TEST_STUB_SEED: "1",
          ATLAS_PROVIDER: "anthropic",
          ATLAS_MODEL: "claude-sonnet-4-5",
        },
      });

      // The full string, not the shared `--mcp-llm requires` prefix: that
      // prefix also matches the provider-resolution failure one branch up, so
      // a model-registry change could slide the test onto a guard it was not
      // written for and it would still pass.
      expect(stderr).toContain(
        '--mcp-llm requires ANTHROPIC_API_KEY for provider "anthropic"',
      );
      expectNoCrash(stderr);
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  test(
    "a clean run exits 0 — the code is derived, not a constant",
    async () => {
      // An empty question set is the one clean run reachable without Postgres:
      // `runDeterministic` builds its `executeSql` closure per question, so
      // zero questions means zero database work. The stdout assertion is what
      // keeps this from being a vacuous pass — it proves the run reached the
      // summary rather than exiting 0 by dying early.
      const sandbox = makeSandbox();
      const questionsPath = path.join(sandbox, "no-questions.yml");
      fs.writeFileSync(questionsPath, "questions: []\n");

      const { exitCode, stdout, stderr } = await runCanonicalEval(sandbox, {
        args: ["--questions", questionsPath],
        preload: true,
        env: { ATLAS_TEST_STUB_SEED: "1" },
      });

      expect(stdout).toContain("0/0");
      expectNoCrash(stderr);
      expect(exitCode).toBe(0);
      expect(fs.existsSync(callersLayerPath(sandbox))).toBe(true);
    },
    120_000,
  );

  test(
    "a THROWN eval body still reports the restore failure as 2",
    async () => {
      // No seed fixture in the sandbox, so `installSchemaSemanticLayer` throws
      // before it touches anything — the one code-less path the `Promise<number>`
      // signature cannot reject. Without the `catch` in `runStagedCanonicalEval`
      // the throw propagates to `main().catch`, which exits 1 unconditionally,
      // and the restore bump computed in the `finally` is discarded: the run
      // that destroyed the caller's semantic layer reports the same code as an
      // ordinary eval failure.
      const sandbox = makeSandbox();
      fs.rmSync(path.join(sandbox, "packages"), { recursive: true });

      const { exitCode, stderr } = await runCanonicalEval(sandbox, {
        preload: true,
        env: {
          ATLAS_TEST_FAIL_CP_FROM: path.join(sandbox, BACKUP_DIR_NAME),
        },
      });

      expect(stderr).toContain("Canonical semantic layer not found");
      expect(stderr).toContain("Failed to restore semantic layer");
      expect(exitCode).toBe(2);
    },
    120_000,
  );

  test(
    "the JSON payload survives process.exit — writeStdoutSync is not buffered",
    async () => {
      // 2 MB against a 64 KiB pipe buffer. `process.exit` discards whatever is
      // still buffered in `process.stdout`, silently and with no error on
      // either side; the real `eval-mcp-llm-output.json` is 63 KB, so the
      // margin here is ~2.5 KB in production. Both arms run so the assertion
      // is anchored to a measured contrast rather than to one number.
      const size = 2_000_000;
      const driver = path.join(
        import.meta.dir,
        "fixtures",
        "canonical-eval-write-stdout-driver.ts",
      );

      const read = async (mode: string): Promise<number> => {
        const proc = Bun.spawn(
          [process.execPath, driver, String(size), mode],
          { stdout: "pipe", stderr: "inherit" },
        );
        children.push(proc);
        const [text] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        return text.length;
      };

      expect(await read("sync")).toBe(size);
      // The contrast, so a future "simplification" back to the buffered stream
      // cannot pass this test by making both arms agree.
      expect(await read("buffered")).toBeLessThan(size);
    },
    120_000,
  );

  test(
    "a restore failure outranks the eval failure — exit 2, not 1",
    async () => {
      const sandbox = makeSandbox();
      const { exitCode, stderr } = await runCanonicalEval(sandbox, {
        preload: true,
        env: {
          ATLAS_TEST_FAIL_CP_FROM: path.join(sandbox, BACKUP_DIR_NAME),
        },
      });

      // Both halves must be present: the body earned 1 (seed failure) and the
      // finally bumped it to 2. Asserting 2 against a run that also earns 1
      // keeps 1 and 2 distinct, so this cannot pass by accidental equality.
      expect(stderr).toContain("failed to seed demo Postgres");
      expect(stderr).toContain("Failed to restore semantic layer");
      expect(exitCode).toBe(2);
      // Exit 2 means "your layer may be gone, it is at $BACKUP_DIR". Assert the
      // scenario the message describes actually holds, so the test is pinned to
      // the branch that motivates the code rather than a benign one.
      expect(fs.existsSync(callersLayerPath(sandbox))).toBe(false);
      expect(fs.existsSync(path.join(sandbox, BACKUP_DIR_NAME))).toBe(true);
    },
    120_000,
  );
});
