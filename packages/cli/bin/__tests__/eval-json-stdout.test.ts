/**
 * `atlas canonical-eval --json` writes JSON to stdout and NOTHING ELSE (#5126).
 *
 * `eval-mcp-llm-output.json` — the failure bundle `.github/workflows/eval-llm.yml`
 * uploads for post-mortems — had never been valid JSON. Two independent writers
 * put non-JSON on fd 1 and the workflow captures fd 1 wholesale:
 *
 *   1. the driver's own human preamble, written unconditionally before any mode
 *      branch, and sufficient on its own;
 *   2. the app's root logger, whose pino default destination is fd 1 — and
 *      because the eval runs with `NODE_ENV` unset (deliberately, #5121) the
 *      dev branch is taken, so the frames arrive PRETTY-PRINTED AND COLOURIZED.
 *      Interleaved, not a strippable prefix.
 *
 * ⚠️ THE TWO POLLUTERS NEED TWO DIFFERENT PROOFS AND ONE OF THEM CANNOT BE
 * WRITTEN IN-PROCESS. The first is a call-site property; the second is a
 * MODULE-EVALUATION-ORDER property — `rootLogger` is a module-scope `const`, so
 * whether it lands on fd 1 or fd 2 is decided once, before `handleCanonicalEval`
 * exists, by whether `packages/cli/bin/eval-log-destination.ts` ran first. No
 * in-process assertion can observe that; every test here that touches it spawns
 * the real CLI and reads the real fds.
 *
 * ⚠️ AND THE SPAWN ALONE IS NOT ENOUGH EITHER, which is the subtle part. These
 * spawns use `--preload`, and a preload module is evaluated BEFORE the entry
 * module — so in this harness the fixture, not `bin/atlas.ts`, is what reaches
 * the logger first. The fixture therefore imports the same stamp module (see its
 * header), and the position of that import inside `bin/atlas.ts` is asserted
 * separately, against the source, by the last test in this file. Together those
 * two cover what neither covers alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "bin", "atlas.ts");
const DRIVER_SRC = path.join(
  REPO_ROOT,
  "packages",
  "cli",
  "bin",
  "canonical-eval-run.ts",
);
const PRELOAD = path.join(
  import.meta.dir,
  "fixtures",
  "canonical-eval-exit-code.preload.ts",
);

/** ESC. `pino-pretty` with `colorize: true` emits these; JSON never does. */
const ESC = "\u001b";

const sandboxes: string[] = [];
const children: Array<{ kill: () => void; exited: Promise<number> }> = [];

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (!child) continue;
    child.kill();
    await child.exited;
  }
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A cwd the CLI can stage into — a seed fixture for `--schema ecommerce` plus a
 * pre-existing `semantic/`. Mirrors `canonical-eval-exit-code.test.ts`; both
 * files need it and neither owns it, so it is duplicated rather than shared
 * through a helper module that would then be a third thing to keep in step.
 */
function makeSandbox(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "canonical-eval-json-")),
  );
  sandboxes.push(dir);

  const seedEntities = path.join(
    dir, "packages", "cli", "data", "seeds", "ecommerce", "semantic", "entities",
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

/**
 * Questions that all grade `fail` with no database — `resolveQuestion` returns
 * `fail` for an unknown `metric_id` before it ever builds SQL, so the run
 * exercises the real grading loop and the real per-question progress writer
 * without a live Postgres.
 *
 * Small on purpose: the 65_536-byte truncation cliff is
 * `canonical-eval-exit-code.test.ts`'s subject and is proved there with a
 * deliberately oversized corpus. What this file needs from the body is only
 * that it PARSES, and a short one keeps each spawn cheap.
 */
function writeCorpus(sandbox: string, count: number): string {
  const questions = Array.from({ length: count }, (_, i) => {
    const id = `cq-${String(i + 1).padStart(3, "0")}`;
    return [
      `  - id: ${id}`,
      `    question: "what is ${id}?"`,
      `    mode: metric`,
      `    category: simple_metric`,
      `    metric_id: no_such_metric_${i}`,
      `    expect: {}`,
    ].join("\n");
  });
  const file = path.join(sandbox, "questions.yml");
  fs.writeFileSync(file, `questions:\n${questions.join("\n")}\n`);
  return file;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly args?: string[];
  readonly env?: Record<string, string>;
  /**
   * Run through a real shell pipeline (`… | cat`) rather than `Bun.spawn`'s own
   * pipe. That is the shape CI stands in (`… --json | tee eval-mcp-llm-output.json`)
   * and, per `canonical-eval-exit-code.test.ts`, the only one that reproduces
   * the 65_536-byte truncation cliff. Kept on for the `--json` tests so this
   * file's "the artifact parses" claim is a claim about the artifact CI
   * actually gets, not about a friendlier pipe.
   */
  readonly shellPipe?: boolean;
}

async function runCanonicalEval(
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const argv = [
    process.execPath,
    "--preload",
    PRELOAD,
    CLI_ENTRY,
    "canonical-eval",
    ...(options.args ?? []),
  ];
  const command =
    options.shellPipe === true
      ? [
          "bash",
          "-c",
          `set -o pipefail; ${argv
            .map((a) => `'${a.replaceAll("'", `'\\''`)}'`)
            .join(" ")} | cat`,
        ]
      : argv;

  const proc = Bun.spawn(command, {
    cwd,
    // Built from scratch, not spread from `process.env`. NODE_ENV in
    // particular MUST be absent: it is what puts the logger on its dev branch
    // (`pino-pretty`, `colorize: true`), which is the CI shape (#5121) and the
    // only one that can emit the ANSI escapes asserted below.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ATLAS_DATASOURCE_URL: "postgres://atlas:atlas@127.0.0.1:1/atlas_demo",
      ATLAS_DEPLOY_MODE: "self-hosted",
      ATLAS_DEPLOY_ENV: "development",
      ...(options.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("canonical-eval --json keeps stdout machine-readable", () => {
  test(
    "stdout parses with no stripping while a log frame and the preamble land on stderr",
    async () => {
      const sandbox = makeSandbox();
      const questionsPath = writeCorpus(sandbox, 3);

      const { exitCode, stdout, stderr } = await runCanonicalEval(sandbox, {
        args: ["--questions", questionsPath, "--json"],
        env: { ATLAS_TEST_STUB_SEED: "1", ATLAS_TEST_EMIT_LOG: "1" },
        shellPipe: true,
      });

      // NO SLICING. `JSON.parse` on the whole stream is the acceptance
      // criterion verbatim; the pre-#5126 behaviour fails here on the first
      // character of the banner.
      const parsed = JSON.parse(stdout) as {
        total: number;
        passing: number;
        failing: number;
        results: unknown[];
      };
      // 3/0/3 rather than 0/0/0: a mapping that confused passing with failing,
      // or emitted a fixed shape, cannot satisfy all four at once.
      expect(parsed.total).toBe(3);
      expect(parsed.passing).toBe(0);
      expect(parsed.failing).toBe(3);
      expect(parsed.results).toHaveLength(3);
      expect(exitCode).toBe(1);

      // Polluter 1 — the driver's own preamble, now on fd 2. Both halves
      // asserted: present on stderr AND absent from stdout. Present-only would
      // pass if the line were written to both.
      expect(stderr).toContain("Atlas canonical-question eval");
      expect(stdout).not.toContain("Atlas canonical-question eval");
      // …including the per-question progress lines, which are the writer that
      // interleaves rather than prefixes.
      expect(stderr).toContain("cq-001 simple_metric");
      expect(stdout).not.toContain("cq-001 simple_metric");

      // Polluter 2 — the app logger. Same two halves.
      expect(stderr).toContain("probe log line");
      expect(stdout).not.toContain("probe log line");

      // ⚠️ The ANSI assertion needs BOTH arms or it proves nothing: `colorize`
      // silently off would satisfy "stdout has no ESC" while telling us
      // nothing about where the frames went. Requiring ESC on stderr pins that
      // the run really did take the pretty+colour branch.
      expect(stderr).toContain(ESC);
      expect(stdout).not.toContain(ESC);
    },
    180_000,
  );

  test(
    "without --json the human transcript stays on stdout",
    async () => {
      // The counterpart arm. Without it every assertion above is satisfied by
      // "route the preamble to stderr always", which would silently break the
      // interactive command this eval is also used as.
      const sandbox = makeSandbox();
      const questionsPath = writeCorpus(sandbox, 3);

      const { exitCode, stdout } = await runCanonicalEval(sandbox, {
        args: ["--questions", questionsPath],
        env: { ATLAS_TEST_STUB_SEED: "1" },
      });

      expect(stdout).toContain("Atlas canonical-question eval");
      expect(stdout).toContain("cq-001 simple_metric");
      // `formatSummary`, the non-`--json` body, on fd 1 as it always was. The
      // full line, so the three counts are distinct and the assertion cannot be
      // satisfied by a summary that confuses pass with fail.
      expect(stdout).toContain("0/3 passing  (0 warn, 3 fail)");
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  test("canonical-eval-run.ts never writes to stdout except through the fd writer", () => {
    // The grep IS the guard. Every assertion above is about the call sites that
    // exist today; this one is about the next one somebody adds — a fresh
    // `process.stdout` write is the whole defect, and it would sail past a
    // suite that only re-checks the known lines.
    //
    // ⚠️ Matched as a CALL (trailing paren) so the prose above `writeFdSync`,
    // which names the pattern, is not itself a violation. Comments in that file
    // deliberately spell it without the paren for the same reason.
    const source = fs.readFileSync(DRIVER_SRC, "utf-8");
    const calls = source.match(/process\.stdout\.write\s*\(/g) ?? [];
    expect(calls).toEqual([]);

    // Anchored: the writer this replaced them with is still there, so the test
    // cannot pass by the file having been renamed out from under it.
    expect(source).toContain("function writeFdSync(");
    expect(source).toContain("function humanWriter(");
  });

  test("bin/atlas.ts imports the log-destination stamp before anything else", () => {
    // The one property the spawns above structurally cannot see: they preload a
    // fixture that reaches the logger first, so `bin/atlas.ts`'s own ordering is
    // masked. Move the stamp below `../src/env-check` in production and every
    // `--json` run pollutes again while this suite stays green — which is the
    // regression this test exists for.
    const source = fs.readFileSync(CLI_ENTRY, "utf-8");
    const firstImport = source.search(/^import\b/m);
    expect(firstImport).toBeGreaterThan(-1);
    // Sliced to a bounded window purely so a failure prints the offending
    // import rather than the whole 400-line entrypoint.
    expect(source.slice(firstImport, firstImport + 120)).toStartWith(
      'import "./eval-log-destination";',
    );
  });
});
