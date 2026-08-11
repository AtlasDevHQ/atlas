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
const STAMP_SRC = path.join(
  REPO_ROOT, "packages", "cli", "bin", "eval-log-destination.ts",
);
const PRELOAD = path.join(
  import.meta.dir,
  "fixtures",
  "canonical-eval-exit-code.preload.ts",
);

/**
 * Every module the `canonical-eval` process runs through whose ENTIRE fd-1
 * surface belongs to the eval. The property the artifact needs is process-wide;
 * a guard over one file is not it — the third polluter was a `console.log` in a
 * file no driver-scoped guard would ever have opened.
 *
 * ⚠️ `src/commands/init.ts` is not on this WHOLE-FILE list, because it
 * legitimately owns fd 1 — it is the interactive `init` command, 50-odd
 * `console.log`s of it — and only `seedDemoPostgres` inside it is on the eval
 * path. It gets a function-scoped arm of the same guard instead; see
 * {@link SEED_FN_SIGNATURE}.
 */
const FD1_GUARDED_SOURCES = [
  "packages/cli/bin/canonical-eval-run.ts",
  "packages/cli/bin/canonical-eval.ts",
  "packages/cli/bin/canonical-eval-mcp-llm.ts",
  "packages/cli/bin/canonical-eval-tool-selection.ts",
  "packages/cli/bin/eval-log-destination.ts",
].map((p) => path.join(REPO_ROOT, p));

const SEED_SRC = path.join(REPO_ROOT, "packages/cli/src/commands/init.ts");

/**
 * The one function in `init.ts` that runs inside `canonical-eval`.
 *
 * ⚠️ THIS ARM EXISTS BECAUSE THE BEHAVIOURAL SUBSTITUTE WAS WEAKER THAN THE
 * GREP IT REPLACED, which is the same defect as the bug being fixed, one layer
 * over. `src/__tests__/seed-demo-report.test.ts` spies `console` methods and
 * `process.stdout.write` during the real call — genuinely stronger for a helper
 * the function DELEGATES to, and that is why it stays — but it cannot see
 * `Bun.stdout` or `fs.writeSync(1, …)`, two of the four spellings this file
 * declares forbidden three lines up. Neither check subsumes the other: the spy
 * covers delegation, the grep covers spellings. Both, or the class is open.
 */
const SEED_FN_SIGNATURE = "export async function seedDemoPostgres(";

/**
 * Slice one top-level function's body out of a source file.
 *
 * Brace-naive on purpose: it ends at the first line that is exactly `}`, which
 * in a prettier-formatted file is the function's own closing brace and nothing
 * else. It fails LOUD rather than silently returning too little — the callers
 * assert the slice actually contains the body's last statement.
 */
function topLevelFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Ways to reach fd 1 that are not `writeFdSync`. `console.error` / `.warn` are
 * fd 2 and deliberately absent.
 *
 * ⚠️ `fs.writeSync(1` is listed but `fs.writeSync(fd` is not — the latter IS
 * `writeFdSync`'s own body, which is the one sanctioned writer.
 */
const FD1_WRITE =
  /(?:process\.stdout|console\.(?:log|info|debug|dir|table|trace)\s*\(|Bun\.stdout|fs\.writeSync\(\s*1\b)/g;

/**
 * Strip comments before matching, so the prose that DESCRIBES the forbidden
 * spellings is not itself a violation.
 *
 * ⚠️ This is the reword-not-exempt problem in miniature: a lexical guard cannot
 * tell a quotation from an assertion, and `canonical-eval-run.ts`'s comments
 * necessarily name `process.stdout` to explain why it is banned. Stripping is
 * the honest answer; an allowlist would be a hole shaped like the thing being
 * guarded. Only whole-line `//` comments are dropped, so a `//` inside a string
 * literal (`postgres://…`) survives — which fails SAFE, since the worst case is
 * a false positive on a trailing comment that names a banned spelling.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

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
        mode: string;
        total: number;
        passing: number;
        warning: number;
        failing: number;
        results: Array<{ id: string; status: string }>;
      };
      // ⚠️ COUNTS ALONE CANNOT CARRY THIS. An all-fail corpus pins `passing`,
      // `warning` and `total - failing` to the same degenerate 0, so `total`
      // and `failing` are indistinguishable and swapping those two keys in the
      // emitter stays green. The per-result arrays are what make the shape
      // falsifiable without a database.
      expect(parsed.total).toBe(3);
      expect(parsed.passing).toBe(0);
      expect(parsed.warning).toBe(0);
      expect(parsed.failing).toBe(3);
      expect(parsed.mode).toBe("deterministic");
      expect(parsed.results.map((r) => r.id)).toEqual([
        "cq-001",
        "cq-002",
        "cq-003",
      ]);
      expect(parsed.results.map((r) => r.status)).toEqual([
        "fail",
        "fail",
        "fail",
      ]);
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

      // Polluter 3 — `seedDemoPostgres`'s demo label, the one OUTSIDE this
      // module and the one the first cut of this fix missed entirely. The
      // preload's stub reports it through the injected sink, so what this
      // actually asserts is that `runInstalledCanonicalEval` passes `human`
      // rather than a `console.log` default.
      expect(stderr).toContain("E-commerce demo loaded");
      expect(stdout).not.toContain("E-commerce demo loaded");

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
        // ⚠️ EMIT_LOG is on here too, and it is not symmetry for its own sake:
        // without it, nothing in this suite asserts the STAMP is conditional.
        // Delete the `if` in `eval-log-destination.ts` — leaving a bare
        // `ATLAS_LOG_STDERR = "1"` that fires for every command — and every
        // other test still passes, because they all pass `--json`.
        env: { ATLAS_TEST_STUB_SEED: "1", ATLAS_TEST_EMIT_LOG: "1" },
      });

      expect(stdout).toContain("Atlas canonical-question eval");
      expect(stdout).toContain("cq-001 simple_metric");
      expect(stdout).toContain("E-commerce demo loaded");
      // The logger stays on fd 1 — the app-wide default — for an interactive
      // run, colour and all.
      expect(stdout).toContain("probe log line");
      expect(stdout).toContain(ESC);
      // `formatSummary`, the non-`--json` body, on fd 1 as it always was. The
      // full line, so the three counts are distinct and the assertion cannot be
      // satisfied by a summary that confuses pass with fail.
      expect(stdout).toContain("0/3 passing  (0 warn, 3 fail)");
      expect(exitCode).toBe(1);
    },
    180_000,
  );

  test(
    "--mcp-llm --json keeps its own preamble off stdout",
    async () => {
      // ⚠️ THIS IS THE BRANCH THE CI ARTIFACT ACTUALLY COMES FROM, and it looked
      // untestable — `runMcpLlmMode` is behind a provider check. It is not:
      // `providerKeyMissing` returns null for `ollama`, so the run reaches the
      // provider line, the baseline line and `resolveExpectations` before dying
      // in ground-truth resolution on the unknown metric ids. Four `human` call
      // sites in the mode that produces `eval-mcp-llm-output.json`, for one
      // spawn and no API key.
      //
      // It stops before the payload, so there is no JSON to parse — which makes
      // `stdout === ""` the whole assertion, and a strong one: any of those
      // writes reverting to fd 1 fails it.
      const sandbox = makeSandbox();
      const questionsPath = writeCorpus(sandbox, 3);

      const { stdout, stderr } = await runCanonicalEval(sandbox, {
        args: ["--questions", questionsPath, "--mcp-llm", "--json"],
        env: {
          ATLAS_TEST_STUB_SEED: "1",
          ATLAS_TEST_EMIT_LOG: "1",
          ATLAS_PROVIDER: "ollama",
          ATLAS_MODEL: "llama3",
        },
        shellPipe: true,
      });

      expect(stdout).toBe("");
      // Named individually rather than by a single "stderr is non-empty", so a
      // run that died before `runMcpLlmMode` cannot satisfy this.
      expect(stderr).toContain("using LLM provider=ollama");
      expect(stderr).toContain("E-commerce demo loaded");
      expect(stderr).toContain("probe log line");
    },
    180_000,
  );

  test(
    "--tool-selection --json keeps its own preamble off stdout",
    async () => {
      // Same trick for the third mode. `runToolSelectionMode` writes the
      // fixture line before it calls the grader, so one spawn reaches it.
      const sandbox = makeSandbox();
      const questionsPath = writeCorpus(sandbox, 3);
      const fixturePath = path.join(sandbox, "tool-selection.json");
      fs.writeFileSync(
        fixturePath,
        JSON.stringify({ rubric: { acceptance_floor: 0.9 }, items: [] }),
      );

      const { stdout, stderr } = await runCanonicalEval(sandbox, {
        args: [
          "--questions", questionsPath,
          "--mcp-llm", "--tool-selection",
          "--tool-selection-fixture", fixturePath,
          "--json",
        ],
        env: {
          ATLAS_TEST_STUB_SEED: "1",
          ATLAS_PROVIDER: "ollama",
          ATLAS_MODEL: "llama3",
        },
        shellPipe: true,
      });

      expect(stdout).toBe("");
      expect(stderr).toContain("tool-selection fixture:");
    },
    180_000,
  );

  test("no eval module writes to fd 1 outside the sanctioned writer", () => {
    // The grep IS the guard, and it is the ONLY falsifier for any branch a
    // spawn cannot reach. Every spawn above is about the call sites that exist
    // today; this is about the next one somebody adds.
    //
    // ⚠️ THE SPELLING MATTERS MORE THAN THE FILE. The first cut of this guard
    // matched `process.stdout.write(` in one file, and the defect that shipped
    // past it was a `console.log` in a DIFFERENT file. `console.log` is also
    // the more likely regression by far: it is what the surrounding CLI code
    // uses everywhere, and no `no-console` rule is configured for this package.
    for (const file of FD1_GUARDED_SOURCES) {
      const source = stripComments(fs.readFileSync(file, "utf-8"));
      expect({ file, hits: source.match(FD1_WRITE) ?? [] }).toEqual({
        file,
        hits: [],
      });
    }

    // Anchored: the writers these were replaced with are still there, so the
    // test cannot pass by the file having been gutted out from under it.
    const driver = fs.readFileSync(DRIVER_SRC, "utf-8");
    expect(driver).toContain("function writeFdSync(");
    expect(driver).toContain("function humanWriter(");
  });

  test("seedDemoPostgres's own body reaches fd 1 only through its injected sink", () => {
    // The function-scoped arm. `init.ts` as a whole owns fd 1 legitimately, so
    // the guard is narrowed to the one function `canonical-eval` runs — which
    // is where the third polluter lived, and where the LIKELIEST regression is
    // someone matching the file's house style and reaching for `console.log`.
    const body = topLevelFunctionBody(
      stripComments(fs.readFileSync(SEED_SRC, "utf-8")),
      SEED_FN_SIGNATURE,
    );
    // The slice really is the whole body — a brace-naive cut that stopped early
    // would trivially find no violations.
    expect(body).toContain("await pool.end()");
    expect(body).toContain("report(");
    expect(body.match(FD1_WRITE) ?? []).toEqual([]);
  });

  test("bin/atlas.ts requests the log-destination stamp before any other module", () => {
    // The one property the spawns above structurally cannot see: they preload a
    // fixture that reaches the logger first, so `bin/atlas.ts`'s own ordering is
    // masked. Move the stamp down and every `--json` run pollutes again while
    // the rest of this suite stays green.
    //
    // ⚠️ FIRST MODULE REQUEST, NOT FIRST `import`. `export … from` is a
    // module-graph edge evaluated in source order exactly like `import`, and
    // `bin/atlas.ts` is mostly made of them — including the profiler
    // re-exports, which are precisely what pulls in `@atlas/api/lib/logger`.
    // A guard matching only `^import` would miss the single most likely edit to
    // that file (hoisting or adding a re-export block above line 46).
    const source = fs.readFileSync(CLI_ENTRY, "utf-8");
    const requests = [
      ...source.matchAll(/^(?:import|export)\b[^\n]*?["']([^"']+)["'];?\s*$/gm),
    ].map((m) => m[1]);
    expect(requests[0]).toBe("./eval-log-destination");

    // …and the stamp must have no graph of its own: an import inside it would
    // evaluate before its own assignment and could reach the logger first.
    expect(fs.readFileSync(STAMP_SRC, "utf-8")).not.toMatch(
      /^(?:import|export)\b[^\n]*\bfrom\b/m,
    );
  });
});
