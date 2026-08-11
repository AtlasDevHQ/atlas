/**
 * `atlas eval --json` and `atlas query --json` put JSON on stdout and NOTHING
 * else (#5146) — the property #5126 established for `atlas canonical-eval`,
 * applied to the two sibling commands that still violated it.
 *
 * `atlas eval` had THREE prose writers of its own on fd 1, all reached in a
 * machine mode:
 *
 *   1. `Resuming: N cases already completed` under `--resume`, before the body;
 *   2. `Baseline saved to: <path>` under `--baseline`, after it;
 *   3. `printRegressionReport` under `--compare`, which prints ANSI-coloured
 *      prose AFTER the JSON body — so not even a prefix a `tail` could strip.
 *
 * plus the app logger, whose pino default destination is fd 1 and which — because
 * the CLI runs with `NODE_ENV` unset — takes the dev branch and arrives
 * PRETTY-PRINTED AND COLOURIZED.
 *
 * `atlas query` had one, and it is the interesting one: on the
 * unexpected-response ERROR path, echoing `data.answer` to `io.out` before the
 * `--json` body is reached. See `src/__tests__/query-command.test.ts`, which
 * drives the real command core for it.
 *
 * ⚠️ COUNT WRITERS BY EXECUTION, NOT BY READING THE DRIVER. #5126's real defect
 * was a THIRD writer nobody counted, in another package, on the unconditional
 * path before any mode branch — and the suite that was supposed to catch it ran
 * every `--json` spawn with `ATLAS_TEST_STUB_SEED=1`, whose preload replaced
 * that exact function with a no-op. The harness deleted the polluter and the
 * suite then confirmed the polluter was absent. So the spawns below run the
 * command the way a user runs it, with no stub preload at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { printRegressionReport } from "../eval";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "bin", "atlas.ts");
// The stamp's argv matrix needs a spawn per shape — it reads `process.argv` at
// module-evaluation time, so one process can observe exactly one answer.
// `eval-json-stdout.test.ts` already owns a driver for that; reusing it keeps
// one fixture rather than two that would drift.
const PROBE = path.join(import.meta.dir, "fixtures", "eval-log-destination-driver.ts");

/** ESC. `pino-pretty` with `colorize: true` emits these; JSON never does. */
const ESC = "\u001b";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "atlas-json-stdout-")));
  tmpDirs.push(dir);
  return dir;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnCli(
  argv: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, ...argv], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // ⚠️ `VAR=""`, NEVER `env -u VAR`. Under bun a deleted key is repopulated
      // from `.env`, so unsetting it here would silently test the OTHER code
      // path — the one where a datasource IS configured and the run tries to
      // reach a database.
      ATLAS_DATASOURCE_URL: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("atlas eval — stdout in a machine mode", () => {
  /**
   * A resume file with one completed case. Reaching the `Resuming: …` writer
   * needs only this — it fires before the `ATLAS_DATASOURCE_URL` check, so the
   * run gets that far and then exits with an error on fd 2. No database, no
   * provider key, no seeding.
   */
  function resumeFile(): string {
    const file = path.join(tmpDir(), "resume.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        id: "no-such-case-id",
        schema: "ecommerce",
        question: "q",
        category: "c",
        difficulty: "easy",
        tags: [],
        gold_sql: "SELECT 1",
        predicted_sql: null,
        match: false,
        error: null,
        latency_ms: 1,
        tokens: 1,
        steps: 1,
      })}\n`,
    );
    return file;
  }

  for (const flag of ["--json", "--csv"] as const) {
    test(`writes nothing to stdout before the body under ${flag}`, async () => {
      const res = await spawnCli(["eval", flag, "--limit", "1", "--resume", resumeFile()]);
      // The run dies on the missing datasource URL, so there is no body — which
      // makes this the cleanest possible assertion: everything on fd 1 would be
      // prose, and there is none.
      expect(res.stdout).toBe("");
      // ⚠️ THE RUN HAS TO ACTUALLY REACH THE WRITER, or an empty stdout proves
      // nothing. The `Resuming:` line is the writer; assert it moved to fd 2
      // rather than vanished.
      expect(res.stderr).toContain("Resuming: 1 cases already completed");
    });
  }

  test("puts the resume line back on stdout in HUMAN mode", async () => {
    // The other direction, and the reason the fix is a redirect rather than a
    // deletion: a human run still prints it, on fd 1, where it always was.
    const res = await spawnCli(["eval", "--limit", "1", "--resume", resumeFile()]);
    expect(res.stdout).toContain("Resuming: 1 cases already completed");
    // ⚠️ THE SECOND WRITER'S HUMAN DIRECTION, WHICH HAD NO FALSIFIER. The
    // machine direction is covered three times over, so "route everything to
    // stderr unconditionally" was a free pass. This spawn already reaches the
    // line; asserting it costs nothing.
    expect(res.stdout).toContain("Atlas Eval:");
  });

  /**
   * A cwd with its own `eval/cases/` and `semantic/`, so a run that gets PAST
   * the datasource check does its backup/restore inside a temp dir rather than
   * against the repo's real `semantic/`.
   *
   * ⚠️ `EVAL_DIR`, `BACKUP_DIR` and `SEMANTIC_DIR` are all `path.resolve(…)` —
   * CWD-relative — so this is the whole isolation mechanism.
   */
  function sandbox(): string {
    const dir = tmpDir();
    const cases = path.join(dir, "eval", "cases", "ecommerce");
    fs.mkdirSync(cases, { recursive: true });
    fs.writeFileSync(
      path.join(cases, "ec-001.yml"),
      [
        'id: "ec-001"',
        'question: "What is the total revenue by month?"',
        "schema: ecommerce",
        "difficulty: simple",
        "category: timeseries",
        "tags: [orders]",
        'gold_sql: "SELECT 1"',
        "expected_rows: null",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "semantic", "entities"), { recursive: true });
    fs.writeFileSync(path.join(dir, "semantic", "entities", "mine.yml"), "name: mine\ntable: mine\n");
    return dir;
  }

  /** One JSONL result line for `ec-001`. */
  function resultLine(match: boolean): string {
    return `${JSON.stringify({
      id: "ec-001",
      schema: "ecommerce",
      question: "What is the total revenue by month?",
      category: "timeseries",
      difficulty: "simple",
      tags: ["orders"],
      gold_sql: "SELECT 1",
      predicted_sql: match ? "SELECT 1" : null,
      match,
      error: match ? null : "boom",
      latency_ms: 1,
      tokens: 1,
      steps: 1,
    })}\n`;
  }

  test("--baseline --compare --json: all three prose writers stay off the JSON body", async () => {
    // ⚠️ THIS TEST EXISTS BECAUSE ITS MUTATION SURVIVED. Swapping
    // `printRegressionReport(report, humanOut)` back to a `console.log` sink at
    // the CALL SITE killed nothing — every other case here dies on the missing
    // datasource URL, long before `--compare` is reached, so the one writer that
    // prints AFTER the JSON body had no falsifier at all.
    //
    // `--baseline` is here for the same reason: its `Baseline saved to: …`
    // line ALSO survived its mutation, for the same reason — it runs after the
    // datasource check too. One spawn reaches all three of this command's fd-1
    // writers, in the order `handleEval` runs them (body, baseline, report).
    //
    // Reaching them needs no database: `--resume` marks the only selected case
    // complete, so the per-schema loop has nothing to iterate and never seeds.
    // `ATLAS_DATASOURCE_URL` only has to be non-empty to pass the guard.
    const dir = sandbox();
    const resume = path.join(dir, "resume.jsonl");
    fs.writeFileSync(resume, resultLine(false));
    const baseline = path.join(dir, "baseline.jsonl");
    fs.writeFileSync(baseline, resultLine(true));

    const child = Bun.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "eval",
        "--json",
        "--id",
        "ec-001",
        "--resume",
        resume,
        "--baseline",
        "--compare",
        baseline,
      ],
      {
        cwd: dir,
        env: { ...process.env, ATLAS_DATASOURCE_URL: "postgres://unused/never-connected" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // The body parses — the property the whole issue is about.
    const parsed = JSON.parse(stdout) as { summary?: { total?: number } };
    expect(parsed.summary?.total).toBe(1);
    expect(stdout).not.toContain(ESC);
    // ⚠️ AND THE REPORT WAS ACTUALLY PRODUCED. Without this, a run that skipped
    // `--compare` entirely satisfies the parse above and proves nothing about
    // the writer under test.
    expect(stderr).toContain("Regression Report");
    expect(stderr).toContain("REGRESSIONS (1)");
    expect(stderr).toContain("Baseline saved to:");
    // Written into the sandbox, not the repo — `BASELINES_DIR` is CWD-relative.
    expect(fs.existsSync(path.join(dir, "eval", "baselines"))).toBe(true);
    // The backup dir is a temp-dir artifact, and restore cleans it up.
    expect(fs.existsSync(path.join(dir, ".semantic-backup-eval"))).toBe(false);
  });

  test("the per-schema banner stays off the JSON body — the loop must actually RUN", async () => {
    // ⚠️ THIS WRITER HAD NO FALSIFIER IN EITHER DIRECTION, AND THE REASON IS THE
    // TRAP THIS FILE'S HEADER NAMES. It sits inside `for (const [schema,
    // schemaCases] of bySchema)`, and every other spawn here either dies at the
    // datasource guard before that loop or uses `--resume` to empty `bySchema`.
    // So the writer never executed in any observing process: measured, a
    // `console.log` mutation on it survived all 596 tests in `packages/cli/bin`.
    //
    // The fix is to let the loop iterate and let the SEED fail instead. A
    // syntactically valid but unreachable datasource URL gets past the
    // non-empty guard, `seedDemoPostgres` throws into `handleEval`'s existing
    // per-schema `catch` (fd 2), and the run completes normally — so the JSON
    // body is written and the banner has genuinely run.
    const dir = sandbox();
    const child = Bun.spawn(
      [process.execPath, CLI_ENTRY, "eval", "--json", "--id", "ec-001"],
      {
        cwd: dir,
        env: {
          ...process.env,
          ATLAS_DATASOURCE_URL: "postgres://unused:unused@127.0.0.1:1/never",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // ⚠️ BOTH ASSERTIONS, OR NEITHER PROVES ANYTHING. The parse alone is
    // satisfied by a run that never reached the banner; the stderr check alone
    // is satisfied by a writer that emits to BOTH.
    expect(stderr).toContain("--- Schema: ecommerce");
    const parsed = JSON.parse(stdout) as { summary?: { total?: number } };
    expect(parsed.summary?.total).toBe(1);
    expect(stdout).not.toContain("--- Schema:");

    // ⚠️ AND THE HUMAN DIRECTION, IN THE SAME TEST, BECAUSE IT SURVIVED ON ITS
    // OWN. With only the machine assertions above, moving the banner to
    // `process.stderr.write` UNCONDITIONALLY passes — a human run silently loses
    // it. Every other human-mode spawn in this file dies before the loop, so
    // this is the only place the second direction is reachable.
    const humanDir = sandbox();
    const human = Bun.spawn([process.execPath, CLI_ENTRY, "eval", "--id", "ec-001"], {
      cwd: humanDir,
      env: {
        ...process.env,
        ATLAS_DATASOURCE_URL: "postgres://unused:unused@127.0.0.1:1/never",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [humanOut] = await Promise.all([
      new Response(human.stdout).text(),
      new Response(human.stderr).text(),
      human.exited,
    ]);
    expect(humanOut).toContain("--- Schema: ecommerce");
  });

});

/**
 * ⚠️ THE STAMP IS WHAT IS TESTED HERE — NOT THAT THE LOGGER OBEYS IT.
 *
 * An earlier cut of this file had a spawn asserting `atlas eval --json` put no
 * ANSI on stdout. It passed, and it could not fail: that run dies at the
 * `ATLAS_DATASOURCE_URL` guard and emits NO pino frame at all, so the assertion
 * held over a process in which the polluter never ran. That is this file's own
 * header warning — the harness removing the polluter and the suite then
 * confirming its absence — arriving as an unreached code path rather than a stub.
 * Deleted rather than patched, because reaching a logging path in `atlas eval`
 * needs a live database and a provider key.
 *
 * What remains is the honest split. `ATLAS_LOG_STDERR` being set for the right
 * argv is tested below, both directions. That the logger HONOURS it is a
 * property of the shared logger rather than of this command, and it is proved
 * once — with real pino frames asserted on fd 2 — by the `canonical-eval` spawn
 * in `eval-json-stdout.test.ts`, whose runs get far enough to log.
 */
describe("eval-log-destination — the machine-stdout table", () => {
  async function probe(argv: readonly string[]): Promise<string> {
    const child = Bun.spawn([process.execPath, PROBE, ...argv], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    // fd 2 — the driver writes there deliberately, so its own stdout stays free.
    const [out] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return out.trim();
  }

  // Both tokens are required, so each row needs its own case — and the
  // command-without-flag cases are what keep the stamp from firing on every
  // `atlas query` a human runs interactively.
  const STAMPED: ReadonlyArray<readonly string[]> = [
    ["canonical-eval", "--mcp-llm", "--json"],
    ["eval", "--json"],
    ["eval", "--csv"],
    ["query", "how many users?", "--json"],
    ["query", "how many users?", "--csv"],
  ];
  for (const argv of STAMPED) {
    test(`stamps for: ${argv.join(" ")}`, async () => {
      expect(await probe(argv)).toBe("ATLAS_LOG_STDERR=1");
    });
  }

  const UNSTAMPED: ReadonlyArray<readonly string[]> = [
    ["eval"],
    ["query", "how many users?"],
    ["canonical-eval", "--mcp-llm"],
    // `canonical-eval` has no `--csv`, and adding it to that row would stamp a
    // flag the command does not accept.
    ["canonical-eval", "--csv"],
    // A command not in the table at all, carrying the flag.
    ["init", "--json"],
  ];
  for (const argv of UNSTAMPED) {
    test(`does NOT stamp for: ${argv.join(" ")}`, async () => {
      // ⚠️ THE NEGATIVE HALF. Without it, `ATLAS_LOG_STDERR = "1"` written
      // unconditionally passes every case above — a stamp that always fires is
      // indistinguishable from a correct table, and it would silently move the
      // logger off stdout for every interactive command.
      expect(await probe(argv)).toBe("ATLAS_LOG_STDERR=<unset>");
    });
  }
});

describe("printRegressionReport", () => {
  test("writes to its sink and NEVER to the console", () => {
    // ⚠️ THE SPY IS THE POINT. Passing a sink and asserting the sink filled up
    // is satisfied by a function that writes to BOTH — which is exactly what a
    // half-applied fix produces, and exactly the shape that leaves ANSI after
    // the JSON body.
    const lines: string[] = [];
    const original = console.log;
    let consoleCalls = 0;
    console.log = () => {
      consoleCalls++;
    };
    try {
      printRegressionReport(
        {
          regressions: [
            {
              id: "e-001",
              schema: "ecommerce",
              question: "how many orders?",
              category: "simple",
              difficulty: "easy",
              tags: [],
              gold_sql: "SELECT 1",
              predicted_sql: null,
              match: false,
              error: "boom",
              latency_ms: 1,
              tokens: 1,
              steps: 1,
            },
          ],
          newPasses: [],
          newCases: [],
          stable: 3,
        },
        (line) => lines.push(line),
      );
    } finally {
      console.log = original;
    }
    expect(consoleCalls).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("REGRESSIONS (1)");
    expect(text).toContain("e-001");
    // The report is what carries ANSI into the pipe — assert it is still being
    // produced, so "no console" cannot be satisfied by producing nothing.
    expect(text).toContain(ESC);
  });
});
