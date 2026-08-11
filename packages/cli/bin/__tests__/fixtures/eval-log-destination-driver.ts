/**
 * Driver for the stamp's argv matrix (#5126).
 *
 * Imports the real stamp module for its side effect and prints the resulting
 * `ATLAS_LOG_STDERR`. A spawn per argv shape is the only way to test this: the
 * stamp reads `process.argv` at module-evaluation time, so one process can
 * observe exactly one answer.
 *
 * Writes to fd 2 on purpose — this driver's own stdout is irrelevant to what it
 * measures, and keeping it clear means a future assertion can use either fd.
 */
import "../../eval-log-destination";

process.stderr.write(`ATLAS_LOG_STDERR=${process.env.ATLAS_LOG_STDERR ?? "<unset>"}\n`);
