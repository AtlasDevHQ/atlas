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
// `writeFdSync`, not the `writeStdoutSync` / `writeStderrSync` wrappers — those
// are module-private on purpose. Each is assignable to every `(text: string) =>
// void` sink in the codebase, so exporting one put a ready-made wrong argument
// one import away from the call sites that caused #5126. `(fd, text)` fits no
// sink, and the wrappers are one-line aliases with nothing of their own to test.
import { writeFdSync } from "../../canonical-eval-run";

const size = Number(process.argv[2] ?? "0");
const payload = "x".repeat(size);
const fd = process.argv[4] === "2" ? 2 : 1;

if (process.argv[3] === "sync") {
  writeFdSync(fd, payload);
} else if (fd === 2) {
  process.stderr.write(payload);
} else {
  process.stdout.write(payload);
}
process.exit(0);
