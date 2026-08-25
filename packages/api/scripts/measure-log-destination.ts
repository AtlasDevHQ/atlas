/**
 * Pin the app logger to fd 2 for `measure-disclaimer-share.ts` (#5420).
 *
 * ⚠️ THIS MODULE EXISTS ENTIRELY FOR ITS IMPORT-TIME SIDE EFFECT, AND IT MUST
 * STAY THAT SCRIPT'S FIRST IMPORT. `lib/logger.ts`'s `rootLogger` is a
 * module-scope `const`; pino resolves its destination once, at construction,
 * and on the dev branch that destination lives inside a `pino-pretty` WORKER
 * THREAD with its own fds. A later `process.env` assignment changes nothing on
 * either branch, so there is no runtime substitute and no second chance. This
 * module deliberately has NO IMPORTS OF ITS OWN — one would evaluate before the
 * assignment below and could reach the logger first.
 *
 * Same mechanism as `packages/cli/bin/eval-log-destination.ts` (#5126, #5146),
 * with the argv pre-scan dropped: that file has to decide per invocation
 * whether stdout is a machine channel, and here it always is. The script's only
 * successful output is ONE LINE OF JSON on stdout, meant to be piped to `jq`
 * and pasted into #5420.
 *
 * The pollution this closes is not hypothetical, and it is not only this
 * script's own logging. `strippedForExtraction` runs over every message and
 * emits a `log.warn` whenever the mail parser throws — above the default level,
 * so on any corpus containing one message the parser chokes on, an unpinned run
 * interleaves pino frames with the JSON and `| jq` fails. It also emits
 * `log.debug` frames under `ATLAS_LOG_LEVEL=debug`. Count fd-1 writers by
 * EXECUTION, not by reading the success path — that is #5126's own lesson.
 *
 * ⚠️ IT OVERRIDES AN EXISTING VALUE, INCLUDING `ATLAS_LOG_STDERR=0`. A parseable
 * stdout is a correctness property of this script's output, not a preference.
 */
process.env.ATLAS_LOG_STDERR = "1";

export {};
