/**
 * Driver for the blocking-write truncation tests (`#5130`, extended to fd 2 by
 * `#5126`).
 *
 * The defect only exists in the interaction between a buffered write and
 * `process.exit`, so it cannot be observed in-process — the test spawns this,
 * pipes it, and counts the bytes that survive.
 *
 *   argv[2] — payload size in bytes
 *   argv[3] — "sync" for the blocking helper, anything else for the buffered
 *             stream write the helper replaced
 *   argv[4] — "2" to exercise fd 2, anything else (or absent) for fd 1
 *
 * ⚠️ fd 2 IS NOT SYMMETRY. Until #5126 the only things on fd 2 were bounded
 * failure diagnostics, so the cliff there was latent and `writeStderrSync` did
 * not exist. Under `--json` the entire human transcript moves to fd 2 —
 * unbounded in principle, since the `note:` lines interpolate caught error
 * messages and `--questions` is caller-supplied — which is what made the twin
 * necessary and what makes this arm a real falsifier rather than a mirror.
 */
import { writeStdoutSync, writeStderrSync } from "../../canonical-eval-run";

const size = Number(process.argv[2] ?? "0");
const payload = "x".repeat(size);
const useStderr = process.argv[4] === "2";

if (process.argv[3] === "sync") {
  if (useStderr) writeStderrSync(payload);
  else writeStdoutSync(payload);
} else if (useStderr) {
  process.stderr.write(payload);
} else {
  process.stdout.write(payload);
}
process.exit(0);
