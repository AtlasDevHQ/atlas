/**
 * The `console` methods that reach **fd 1**, as one list (#5126).
 *
 * ⚠️ ONE LIST BECAUSE TWO LISTS DRIFTED IMMEDIATELY. The fd-1 guard's regex
 * (`bin/__tests__/eval-json-stdout.test.ts`) and the spy in
 * `src/__tests__/seed-demo-report.test.ts` each hand-maintained
 * `log|info|debug|dir|table|trace`, in two packages, agreeing only by
 * maintenance — and both were wrong the same way. Measured on bun 1.3.13 with
 * stdout redirected to a file, `console.group` and `console.count` land on
 * fd 1 and were in neither, so a `console.group` added beside the demo seed's
 * sink was a live surviving mutation past both arms.
 *
 * It lives in `fixtures/` rather than in either test file because importing a
 * `*.test.ts` from another test file would re-run its suite in the importer's
 * process.
 *
 * Measured on bun 1.3.13 in this worktree, stdout redirected to a file:
 *
 *   fd 1 — log, info, debug, dir, table, group, groupCollapsed, count, TRACE
 *   fd 2 — error, warn, timeEnd, timeLog
 *
 * So `error` and `warn` are absent deliberately. `trace` is here on bun's own
 * behaviour, not as over-coverage — an earlier draft of this comment had it on
 * fd 2 and dismissed it as harmless, which was backwards on the runtime that
 * actually produces the CI artifact. `timeEnd` and `timeLog` ARE the
 * over-coverage case: fd 2 on bun, fd 1 in node, listed because the placement
 * is runtime-dependent and costs nothing to keep.
 */
export const STDOUT_CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "table",
  "group",
  "groupCollapsed",
  "groupEnd",
  "count",
  "countReset",
  "trace",
  "timeEnd",
  "timeLog",
] as const;
