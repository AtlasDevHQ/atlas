/**
 * Move the app logger off stdout for `atlas canonical-eval … --json` (#5126).
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
 * Under `--json` stdout is a MACHINE channel: the workflow runs
 * `… canonical-eval --mcp-llm --json | tee eval-mcp-llm-output.json` and uploads
 * the result as the adjudication artifact. That file had never parsed — two
 * independent writers put prose on fd 1, and the logger's was the one that also
 * carried ANSI escapes, because the eval runs with `NODE_ENV` unset (#5121) so
 * `isDev` is true even in CI and the transport is `pino-pretty` with
 * `colorize: true`.
 *
 * ⚠️ THE ARGV SCAN IS DELIBERATELY DUPLICATED FROM `parseCanonicalEvalOptions`,
 * not shared with it. That parser is the real one and it stays the real one —
 * but it runs from inside `handleCanonicalEval`, hundreds of module
 * evaluations too late to matter here. A positional pre-scan is the only thing
 * available at this point in the process's life. It is narrow on purpose: both
 * tokens must be present, so no other subcommand is affected, and the two
 * spellings cannot drift far because `--json` is `canonical-eval`'s flag.
 *
 * ⚠️ IT OVERRIDES AN EXISTING VALUE, INCLUDING `ATLAS_LOG_STDERR=0`. Under
 * `--json` a clean stdout is a correctness property of the artifact, not a
 * preference — an operator who wants the logger back on stdout wants a run
 * without `--json`.
 *
 * Sibling not covered, and the reason is NOT the one an earlier draft of this
 * comment gave. It said `atlas query --json` writes its own human preamble to
 * stdout, so a stamp here would fix only half of it — that is false, and it
 * argued against a fix that would probably work. Verified: `query`'s only
 * preamble is `io.err("Thinking...")`, which is `console.error` (fd 2) AND
 * gated behind `!jsonOutput && !csvOutput`, so on the `--json` success path
 * stdout carries the payload and nothing else. The logger is therefore its ONLY
 * fd-1 polluter and stamping it would likely be the whole fix.
 *
 * Left out anyway, deliberately: it is a different command, nothing in CI
 * captures `query`'s stdout, and widening the stamp at the close of #5126's
 * review would ship an unreviewed behaviour change to a user-facing command.
 * Its own issue, with its own verification that no error branch writes to fd 1.
 */
if (process.argv.includes("canonical-eval") && process.argv.includes("--json")) {
  process.env.ATLAS_LOG_STDERR = "1";
}

export {};
