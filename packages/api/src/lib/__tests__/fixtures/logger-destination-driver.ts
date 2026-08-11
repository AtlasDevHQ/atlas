/**
 * Driver for `../logger-destination.test.ts` (#5126).
 *
 * The property under test is which FILE DESCRIPTOR the root logger writes to,
 * and that is decided once — at module evaluation, from `process.env` — so it
 * cannot be observed in-process: a second arm would need a second module
 * instance, and on the dev branch the destination belongs to a `pino-pretty`
 * worker thread that never existed in this process at all. Each arm is a spawn.
 *
 * No arguments: both switches (`ATLAS_LOG_STDERR`, `NODE_ENV`) are env-borne
 * exactly as they are in production, so the driver has nothing to configure.
 */
import { createLogger } from "@atlas/api/lib/logger";

createLogger("logger-destination-probe").error(
  { probe: "logger-destination" },
  "probe log line",
);
