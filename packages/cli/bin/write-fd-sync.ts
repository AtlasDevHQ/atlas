/**
 * `writeFdSync` — the one sanctioned writer to a standard fd in this package.
 *
 * ⚠️ A LEAF MODULE ON PURPOSE: it imports `fs` and NOTHING ELSE, so a caller can
 * take it without taking a module graph. That is what makes it usable from
 * `brain-paraphrase-eval.ts`, which stamps `ATLAS_LOG_STDERR=1` before any edge
 * that could reach `@atlas/api/lib/logger` and constructs pino's module-scope
 * `rootLogger`. Importing this from `canonical-eval-run.ts` instead — where it
 * lived until #5041 — would pull `./atlas` and `./canonical-eval` in behind it
 * and defeat that stamp.
 *
 * Extracted rather than copied: it is a syscall retry loop with an EPIPE arm, an
 * EAGAIN arm and a zero-return arm, and a second hand-written copy of that is a
 * second set of places for the arms to drift. `__tests__/eval-json-stdout.test.ts`
 * anchors the definition HERE and greps every guarded source for the spellings
 * that bypass it.
 */

import * as fs from "fs";

/**
 * Write to a standard fd with a BLOCKING syscall loop instead of the buffered
 * `process.stdout` / `process.stderr` stream.
 *
 * ⚠️ `process.exit()` DISCARDS whatever is still sitting in a buffered stream,
 * with no error on either side. Measured on bun 1.3.13: a 2 MB payload written
 * via `process.stdout.write` and followed by `process.exit` reaches a pipe
 * truncated — 65_536 bytes (one pipe buffer) under `| wc -c`, 219_264 under a
 * concurrently-draining reader. HOW MUCH survives is whatever the reader
 * drained in time, so it is not a fixed number and not something a caller can
 * budget against; what is fixed is that the tail is lost and nothing says so.
 *
 * That cliff is not theoretical for this command. The workflow runs
 * `canonical-eval --mcp-llm --json | tee eval-mcp-llm-output.json` and uploads
 * the result as the adjudication artifact; the file from the 2026-08-11 run is
 * 63_024 bytes, 2.5 KB under the limit and growing with every field added to
 * the payload. Until #5130 the `--mcp-llm` path left via `return` and the
 * process ended naturally, so the stream always drained — routing it through
 * the shared `process.exit` is what exposes this, which makes it this change's
 * to carry.
 *
 * `fs.writeSync` returns only once the bytes are handed to the fd, so there is
 * nothing left to discard.
 *
 * ⚠️ STDERR HAS THE SAME CLIFF — measured the same way: 200 KB to stderr
 * followed by `process.exit` arrives as 65_536 bytes. It used to be latent,
 * because the only things on fd 2 were the failure-path diagnostics at a few
 * hundred bytes each. #5126 made it live: under `--json` the whole human
 * transcript moves to stderr, including the `note:` lines in
 * `resolveExpectations` and the per-question progress lines, neither of which
 * is bounded in principle (the notes interpolate caught error messages, and
 * `--questions` is caller-supplied). The fd-2 twin the old comment here said
 * "whoever adds an unbounded stderr diagnostic needs first" is therefore what
 * this helper's `fd` parameter provides, and `humanWriter` binds it.
 *
 * ⚠️ EVERY STDOUT WRITE IN THE CALLING DRIVERS GOES THROUGH HERE, AND NOTHING
 * ELSE MAY TOUCH fd 1. That is not tidiness — it is what lets
 * `__tests__/eval-json-stdout.test.ts` assert the invariant by GREP over
 * `FD1_GUARDED_SOURCES` (this module included) rather than by inspection, and a
 * grep is the only check that survives a call site added later.
 *
 * In `canonical-eval-run.ts` the buffered fd-2 writes on the FAILURE paths are
 * deliberately left alone: they are #5130's reasoned exit-code paths, they are
 * small (a few hundred bytes each, except the harness stack, which runs to a few
 * KB), and making them throw on a bad fd 2 would let a write error escape
 * `restoreSemanticLayer`'s catch and discard the exit-2 bump that catch exists
 * to produce.
 *
 * In `canonical-eval-run.ts`, mixing the two write paths on ONE fd was also
 * order-sensitive (a `writeSync`
 * bypasses the stream's queue entirely and can print ahead of an earlier
 * buffered write that has not flushed). On fd 1 that mixing is now gone. It
 * remains on fd 2 in the `--json` shape — human transcript via `humanWriter`,
 * failure diagnostics via the stream — where the ordering measured on bun 1.3.13
 * held on every path, but it is a measurement rather than a guarantee, and fd 2
 * is a diagnostic channel where a reordered line costs nothing that parses.
 * `brain-paraphrase-eval.ts` has no such mixing at all — every fd-2 write there
 * goes through this function.
 */
export function writeFdSync(fd: 1 | 2, text: string): void {
  const buf = Buffer.from(text, "utf-8");
  // A one-word cell purely to get a blocking sleep on the EAGAIN path below;
  // there is no synchronous `sleep` and a bare retry loop would spin at 100%.
  const idle = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buf.length) {
    let written: number;
    try {
      written = fs.writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      // `.code` is read only after narrowing to Error. Reading it off a bare
      // caught value raises a TypeError from inside the handler for `throw null`
      // / `throw undefined` — substituting nonsense for the real write failure —
      // and silently yields `undefined` for a string or number throw.
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      // A reader that hung up (`… | head`, a quit pager) is not a failure and
      // must not become one: the buffered stream this replaced dropped EPIPE
      // silently, and turning `atlas canonical-eval --json | head` into exit 1
      // with a stack trace would be a regression introduced by a flush fix.
      //
      // ⚠️ That reason was written for fd 1 and has to be re-derived for fd 2,
      // which this now also serves: on stderr the swallow discards the REST OF
      // THE HUMAN TRANSCRIPT, which under `--json` is the run's only human
      // record. Still correct — it matches what `process.stderr.write` does
      // with a closed fd 2, and neither the exit code nor the fd-1 payload is
      // affected — but the cost is larger than the fd-1 argument implies.
      //
      // intentionally ignored: the reader hung up. This is the one path here
      // that emits nothing, and that is the correct behaviour for a pipe.
      if (code === "EPIPE") return;
      // EAGAIN drives a RETRY; it is not discarded. A `write(2)` that returns
      // EAGAIN wrote nothing, so re-driving the same offset loses no bytes, and
      // waiting for the reader is exactly what a blocking fd would have done —
      // this branch only exists because the fd may arrive with O_NONBLOCK set.
      // Every other errno (ENOSPC, EBADF) is a real write failure and
      // propagates to the CALLER's handler — `runStagedCanonicalEval`'s catch
      // for everything inside the staged run, `bin/atlas.ts`'s top-level handler
      // for the preamble write that precedes it, and `main().catch` in
      // `brain-paraphrase-eval.ts`. (Noted because that second handler itself
      // writes through this function, so a genuinely broken fd 2 can throw a
      // second time inside the rejection handler; the process still exits
      // non-zero, which is the property that matters.)
      //
      // ⚠️ UNTESTED: nothing in the suite can force EAGAIN on a pipe, so this
      // branch and the sleep below are reasoning, not measurement.
      if (code !== "EAGAIN") throw err;
      Atomics.wait(idle, 0, 0, 1);
      continue;
    }
    // A zero-byte return makes no progress and raises nothing, so without this
    // the loop spins forever with no diagnostic — a hang, which no test can
    // falsify. Fail loudly with the offset reached instead.
    if (written === 0) {
      throw new Error(
        `fd ${fd} write stalled at ${offset}/${buf.length} bytes: write(2) returned 0. ` +
          `Refusing to spin — the remaining payload would be lost silently.`,
      );
    }
    offset += written;
  }
}
