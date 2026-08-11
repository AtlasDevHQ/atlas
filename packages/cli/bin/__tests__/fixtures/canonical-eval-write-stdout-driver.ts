/**
 * Driver for the `writeStdoutSync` truncation test (`#5130`).
 *
 * The defect only exists in the interaction between a buffered write and
 * `process.exit`, so it cannot be observed in-process — the test spawns this,
 * pipes it, and counts the bytes that survive.
 *
 *   argv[2] — payload size in bytes
 *   argv[3] — "sync" to use `writeStdoutSync`, anything else for the buffered
 *             `process.stdout.write` the helper replaced
 */
import { writeStdoutSync } from "../../canonical-eval-run";

const size = Number(process.argv[2] ?? "0");
const payload = "x".repeat(size);

if (process.argv[3] === "sync") {
  writeStdoutSync(payload);
} else {
  process.stdout.write(payload);
}
process.exit(0);
