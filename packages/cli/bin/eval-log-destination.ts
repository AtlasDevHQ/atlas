/**
 * Move the app logger off stdout for every command whose stdout is a MACHINE
 * channel (#5126, widened in #5146).
 *
 * ⚠️ THIS MODULE EXISTS ENTIRELY FOR ITS IMPORT-TIME SIDE EFFECT, AND IT MUST
 * STAY `bin/atlas.ts`'S FIRST IMPORT. `bin/atlas.ts` re-exports from
 * `@atlas/api/lib/profiler`, which imports `@atlas/api/lib/logger`, whose
 * `rootLogger` is a module-scope `const` — pino resolves the destination once,
 * at construction, and on the dev branch that destination lives in a
 * `pino-pretty` worker thread. So there is no later moment at which this can be
 * done: by the time `handleCanonicalEval` runs, the logger has existed for the
 * whole of module evaluation. Moving this import below any other module-graph
 * edge — an `import`, or an `export … from`, of which `bin/atlas.ts` is mostly
 * made — silently restores the defect, which is why
 * `__tests__/eval-json-stdout.test.ts` asserts its position in the source, and
 * why this module deliberately has NO IMPORTS OF ITS OWN: one would evaluate
 * before the assignment below and could reach the logger first.
 *
 * Under `--json` or `--csv` stdout is a MACHINE channel. Taking `canonical-eval`
 * as the worked example: the workflow runs
 * `… canonical-eval --mcp-llm --json | tee eval-mcp-llm-output.json` and uploads
 * the result as the adjudication artifact. That file had never parsed — three
 * independent writers put prose on fd 1 (see the note below on the third), and
 * the logger's was the one that also
 * carried ANSI escapes, because the eval runs with `NODE_ENV` unset (#5121) so
 * `isDev` is true even in CI and the transport is `pino-pretty` with
 * `colorize: true`.
 *
 * ⚠️ THE ARGV SCAN IS DELIBERATELY DUPLICATED FROM `parseCanonicalEvalOptions`,
 * not shared with it. That parser is the real one and it stays the real one —
 * but it runs from inside `handleCanonicalEval`, hundreds of module evaluations
 * too late to matter here. A raw argv pre-scan is the only thing available at
 * this point in the process's life. It is narrow because both tokens must be
 * present, not because only one subcommand is listed — since #5146 the table
 * below carries three, and `--csv` beside `--json`.
 *
 * (This paragraph said "a POSITIONAL pre-scan", "no other subcommand is
 * affected", and "`--json` is `canonical-eval`'s flag". All three were true of
 * #5126's single-command version and none survived #5146; the loop below matches
 * with `includes`, deliberately, and says why.)
 *
 * ⚠️ IT OVERRIDES AN EXISTING VALUE, INCLUDING `ATLAS_LOG_STDERR=0`. Under
 * `--json` a clean stdout is a correctness property of the artifact, not a
 * preference — an operator who wants the logger back on stdout wants a run
 * without `--json`.
 *
 * ── The siblings, covered in #5146 ──
 *
 * #5126 left `atlas eval` and `atlas query` out deliberately — different
 * commands, nothing in CI captures their stdout, and widening the stamp at the
 * close of that review would have shipped an unreviewed behaviour change. #5146
 * is that review. Both are in the table below, and both also needed fixes the
 * stamp cannot make, because the logger was not their only fd-1 writer:
 *
 *   `atlas eval`   THREE prose writers of its own — the `Resuming: …` line, the
 *                  `Baseline saved to: …` line, and `printRegressionReport`,
 *                  which prints ANSI *after* the JSON body and so is not even a
 *                  prefix a `tail` could strip. Fixed at their call sites.
 *   `atlas query`  ONE, and it is on an ERROR path, which is why reading the
 *                  success path did not find it: the unexpected-response branch
 *                  writes `data.answer` to `io.out` BEFORE the `--json` branch
 *                  is reached. Fixed at its call site.
 *
 * ⚠️ THAT SECOND ONE IS THE POINT OF THE ISSUE, RESTATED. An earlier draft of
 * this comment asserted `query`'s logger was its ONLY fd-1 polluter, and said
 * so as a verified fact. It was arrived at by reading the driver's success
 * path. #5126's own defect was a third writer nobody counted — count them by
 * EXECUTION.
 *
 * `--csv` is in the table beside `--json` for `eval` and `query`: both commands
 * hand fd 1 to a CSV body in that mode, and prose interleaved with CSV rows is
 * the same defect wearing a different parser. `canonical-eval` has no `--csv`.
 */
const MACHINE_STDOUT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "canonical-eval": ["--json"],
  eval: ["--json", "--csv"],
  query: ["--json", "--csv"],
};

for (const [command, machineFlags] of Object.entries(MACHINE_STDOUT_COMMANDS)) {
  // BOTH tokens required, and matched with `includes` rather than by argv
  // position. Position would be stricter, but this module runs before anything
  // that knows how the binary was invoked — and `bun run atlas -- <cmd>` shapes
  // argv differently from a direct `bun bin/atlas.ts <cmd>`. Requiring the flag
  // too keeps it narrow: a bare `atlas query "…"` is untouched, and a `query`
  // prompt containing the word `eval` matches a command that already owns fd 1
  // for the same reason.
  //
  // It NARROWS rather than bounds, and the residue is stated rather than implied:
  // any invocation with an argv element literally equal to a table key alongside
  // one of its flags stamps — `atlas plugin add query --json` would. The cost is
  // that logs move to fd 2 for a command that did not ask, which is why this is
  // recorded rather than closed.
  if (
    process.argv.includes(command) &&
    machineFlags.some((flag) => process.argv.includes(flag))
  ) {
    process.env.ATLAS_LOG_STDERR = "1";
    break;
  }
}

export {};
