/**
 * Is a process-level analytics datasource EXPECTED on this deployment? (#4854)
 *
 * `/health` already distinguishes "no datasource is configured" from "the
 * configured datasource is failing" — the first is `components.datasource:
 * "disabled"` and never 503s (#1981), the second is `"down"` and does. What it
 * could not distinguish is whether the *absence* is intentional. Without that,
 * every deployment that legitimately has no process datasource — a multi-tenant
 * SaaS region whose connections live per-workspace (#4124), a knowledge-only or
 * brain-only self-host (#4826) — reports `degraded` forever, which burns the
 * top-level status as a regression signal.
 *
 * **Intent is never inferred from the absence itself.** Doing so would turn a
 * genuine misconfiguration (an operator who meant to set `ATLAS_DATASOURCE_URL`
 * and didn't) into a silent green — the "prefer errors over silent fallbacks"
 * rule. So the expectation must be DECLARED, and an undeclared deployment keeps
 * degrading exactly as it does today.
 *
 * Mirrors the `{ expected: false }` shape of the #4457 scheduled-backup
 * tripwire (`lib/backups/health.ts`), and the env-declaration spelling of
 * `isScheduledBackupEnvDisabled()` (`lib/backups/cadence.ts`).
 *
 * ## Why the env var outranks the config file
 *
 * `api-staging` builds from `deploy/api/Dockerfile`, which COPYs the **prod**
 * `deploy/api/atlas.config.ts` — the separate staging config was retired in
 * #3958. Staging and prod differ only by env vars. A config-file field alone
 * would therefore declare the expectation for prod too, and prod *does* have a
 * datasource: the declaration would suppress the very signal it exists to
 * preserve. The per-service env var is the load-bearing seam; the config field
 * is for self-hosters authoring their own `atlas.config.ts`.
 */

import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("datasource-expectation");

/**
 * `/health` is public and polled, so an unparseable declaration would log on
 * every request. Warn once per process instead — enough for an operator to find
 * the typo, quiet enough not to drown the log.
 */
let warnedUnrecognized = false;

/**
 * Whether this deployment is expected to have a process-level analytics
 * datasource.
 *
 * Precedence, most specific first:
 *   1. `ATLAS_DATASOURCE_EXPECTED` — `false`/`0` declares the absence
 *      intentional, `true`/`1` declares one required (so a shared image can
 *      override a config file that says otherwise, per-service).
 *   2. `datasourceExpected` in `atlas.config.ts`.
 *   3. Undeclared → **expected**. This is the load-bearing default: it is what
 *      keeps a self-hosted box that forgot `ATLAS_DATASOURCE_URL` degrading.
 *
 * Note this answers a question about the DEPLOYMENT, not about the connection's
 * state. A configured datasource that fails its probe is a different condition
 * entirely and is unaffected by this declaration — see the `error` arm in
 * `api/routes/health.ts`, which is reachable only when one IS configured.
 */
export function isDatasourceExpected(): boolean {
  const declared = process.env.ATLAS_DATASOURCE_EXPECTED?.trim().toLowerCase();
  if (declared !== undefined && declared !== "") {
    if (declared === "false" || declared === "0") return false;
    if (declared === "true" || declared === "1") return true;
    if (!warnedUnrecognized) {
      warnedUnrecognized = true;
      log.warn(
        { value: declared },
        "ATLAS_DATASOURCE_EXPECTED is set to an unrecognized value — expected one of true/false/1/0. " +
          "Treating the deployment as expecting a datasource, so a missing one still degrades /health.",
      );
    }
  }

  // `=== false` rather than falsiness: an absent field must fall through to the
  // default, not be read as a declaration that no datasource is expected.
  if (getConfig()?.datasourceExpected === false) return false;

  return true;
}

/** @internal Reset the warn-once latch — for testing only. */
export function _resetDatasourceExpectationWarning(): void {
  warnedUnrecognized = false;
}
