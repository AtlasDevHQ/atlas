/**
 * SaaS CRM wiring — connects Atlas SaaS lead-capture flows into the
 * Twenty CRM instance at `crm.useatlas.dev` via the `@useatlas/twenty`
 * plugin. Self-hosted Atlas gets the Noop layer from
 * `lib/effect/services.ts:NoopSaasCrmLayer`.
 *
 * Transient metadata-probe failures deliberately leave `available: true`
 * — a real schema mismatch surfaces as a 422 on the first upsert call.
 * Deterministic misconfigurations (401/403/404) flip to permanent so
 * leads aren't lost silently against a clearly-broken endpoint.
 */

import { Effect, Layer } from "effect";
import {
  SaasCrm,
  type SaasCrmShape,
  type SaasCrmLeadInput,
} from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import { isEnterpriseEnabled } from "../index";
import {
  getPersonMetadata,
  tryResolveCredentialsFromEnv,
  normalizeLead,
  upsertPerson,
  TwentyClientError,
  type ResolvedTwentyCredentials,
  type TwentyClientConfig,
} from "@useatlas/twenty";

const log = createLogger("ee:saas-crm");

const REQUIRED_PERSON_FIELDS = ["atlasFirstSource", "atlasLastSource"] as const;

/**
 * Atlas's known Twenty CRM hostname. Used as the fallback when
 * `TWENTY_BASE_URL` is unset in the SaaS deployment — self-hosters
 * never hit this code path (Noop layer is the default; if they were
 * to install `@useatlas/twenty`, they go through the plugin's
 * `atlas.config.ts` which requires `baseUrl` explicitly).
 */
const ATLAS_SAAS_TWENTY_BASE_URL = "https://crm.useatlas.dev";

/**
 * Per-request timeout for the SaaS CRM client. Tight on purpose: every
 * lead dispatch sits inside the demo response path, and even though
 * the dispatch is fire-and-forget at the catch-and-swallow layer
 * inside `dispatchLead`, the `await` in `captureDemoLead` would still
 * add latency-on-failure. 3s caps each leg (find + create/patch),
 * keeping worst-case Twenty-outage latency in the demo response under
 * ~6s rather than the 10s default.
 */
const SAAS_TIMEOUT_MS = 3_000;

function missingFieldInstructions(missing: ReadonlyArray<string>): string {
  return (
    `Twenty Person object is missing required Atlas custom field(s): ${missing.join(", ")}. ` +
    `Create them in the Twenty UI under Settings → Data Model → Person → + Add Field. ` +
    `Each field should be of type "Text". SaaS CRM dispatch is disabled until both ` +
    `atlasFirstSource and atlasLastSource exist on the Person object.`
  );
}

function misconfigurationInstructions(status: number, baseUrl: string): string {
  return (
    `Twenty metadata probe returned HTTP ${status} from ${baseUrl}/metadata — ` +
    `this is a deterministic misconfiguration that will NEVER succeed without ` +
    `operator intervention. Check TWENTY_API_KEY (bearer token from Twenty → ` +
    `Settings → API & Webhooks) and TWENTY_BASE_URL (must point at a Twenty ` +
    `instance whose /metadata GraphQL endpoint is reachable). SaaS CRM dispatch ` +
    `is disabled until this is fixed.`
  );
}

/**
 * Build the TwentyClient config with the SaaS defaults applied. The
 * Atlas-internal base URL fallback lives here, NOT in the plugin's
 * schema default — self-hosters who install `@useatlas/twenty`
 * directly must point at their own Twenty.
 */
function buildSaasClientConfig(creds: ResolvedTwentyCredentials): TwentyClientConfig {
  return {
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
    timeoutMs: SAAS_TIMEOUT_MS,
  };
}

/**
 * Run startup verification against the Twenty metadata endpoint.
 *
 * Returns:
 *  - `ok: true` — both required fields are present.
 *  - `ok: false` — fields missing OR upstream returned a deterministic
 *    misconfiguration code (401/403/404). A structured `log.error` has
 *    already been emitted.
 *  - `ok: "transient"` — network / 5xx / parse failure. Layer stays
 *    available; a real schema mismatch will surface as a 422 on the
 *    first upsertPerson call.
 */
async function verifyCustomFields(
  creds: ResolvedTwentyCredentials,
): Promise<{ ok: true } | { ok: false } | { ok: "transient"; reason: string }> {
  const baseUrl = creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL;
  try {
    const meta = await getPersonMetadata({
      apiKey: creds.apiKey,
      baseUrl,
      timeoutMs: SAAS_TIMEOUT_MS,
    });
    const present = new Set(meta.fields.map((f) => f.name));
    const missing = REQUIRED_PERSON_FIELDS.filter((f) => !present.has(f));
    if (missing.length === 0) return { ok: true };
    log.error(
      { missing, event: "saas_crm.custom_fields_missing" },
      missingFieldInstructions(missing),
    );
    return { ok: false };
  } catch (err) {
    // 401/403/404 are deterministic misconfigurations — silently
    // marking them transient would leave `available: true` and every
    // subsequent dispatch would fail identically forever, losing leads.
    if (
      err instanceof TwentyClientError &&
      (err.status === 401 || err.status === 403 || err.status === 404)
    ) {
      log.error(
        {
          status: err.status,
          upstreamCode: err.upstreamCode,
          err: err.message,
          baseUrl,
          event: "saas_crm.metadata_misconfigured",
        },
        misconfigurationInstructions(err.status, baseUrl),
      );
      return { ok: false };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: "transient", reason };
  }
}

/**
 * Dispatch a normalized lead via TwentyClient. Errors are caught and
 * logged inside this function so the SaasCrmShape Effect channel stays
 * typed as `Effect<void>` (no error channel) — that contract is what
 * keeps the call-site short (`yield* SaasCrm` then
 * `yield* upsertLead(input)` with nothing to catch).
 */
async function dispatchLead(
  clientConfig: TwentyClientConfig,
  input: SaasCrmLeadInput,
): Promise<void> {
  try {
    const normalized = normalizeLead(input);
    await upsertPerson(clientConfig, normalized.person);
    log.debug(
      { source: input.source, eventSource: normalized.eventSource },
      "SaaS CRM lead dispatched to Twenty",
    );
  } catch (err) {
    // Twenty being down (or a missing custom field, or a bad key)
    // MUST NOT block the caller. Log loudly so an operator can
    // correlate, but never re-throw.
    if (err instanceof TwentyClientError) {
      log.warn(
        {
          source: input.source,
          status: err.status,
          upstreamCode: err.upstreamCode,
          operation: err.operation,
          err: err.message,
          event: "saas_crm.dispatch_failed",
        },
        "Twenty upsertPerson failed — lead lost (durable outbox not yet implemented)",
      );
    } else {
      log.warn(
        {
          source: input.source,
          err: err instanceof Error ? err.message : String(err),
          event: "saas_crm.dispatch_failed",
        },
        "Twenty dispatch threw unexpectedly — lead lost",
      );
    }
  }
}

// Boot-time verification runs once inside Layer.effect; available reflects that one check.
export const SaasCrmLive: Layer.Layer<SaasCrm> = Layer.effect(
  SaasCrm,
  Effect.gen(function* () {
    const enterpriseOn = isEnterpriseEnabled();
    if (!enterpriseOn) {
      log.info("Enterprise disabled — SaasCrm.available=false");
      return {
        available: false,
        upsertLead: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const creds = tryResolveCredentialsFromEnv();
    if (!creds) {
      log.warn(
        { event: "saas_crm.credentials_absent" },
        "TWENTY_API_KEY not set — SaasCrm.available=false. Set TWENTY_API_KEY (and optionally TWENTY_BASE_URL) to enable SaaS CRM dispatch.",
      );
      return {
        available: false,
        upsertLead: () => Effect.void,
      } satisfies SaasCrmShape;
    }

    const verifyResult = yield* Effect.promise(() => verifyCustomFields(creds));
    if (verifyResult.ok === false) {
      // Already logged inside verifyCustomFields (missing fields OR
      // deterministic misconfiguration). Surface unavailable so
      // subsequent demo signups are no-ops rather than dead-letter
      // rows in the (future) outbox.
      return {
        available: false,
        upsertLead: () => Effect.void,
      } satisfies SaasCrmShape;
    }
    if (verifyResult.ok === "transient") {
      log.warn(
        { err: verifyResult.reason, event: "saas_crm.verify_transient_failure" },
        "Twenty metadata endpoint errored during boot verification — assuming custom fields are present. " +
          "A real schema mismatch will surface as a 422 on the first upsertPerson call.",
      );
    } else {
      log.info(
        {
          baseUrl: creds.baseUrl ?? ATLAS_SAAS_TWENTY_BASE_URL,
          event: "saas_crm.ready",
        },
        "SaasCrm wired up — atlasFirstSource + atlasLastSource verified on Twenty Person",
      );
    }

    const clientConfig = buildSaasClientConfig(creds);

    return {
      available: true,
      upsertLead: (input) =>
        Effect.promise(() => dispatchLead(clientConfig, input)),
    } satisfies SaasCrmShape;
  }),
);

// Re-exported for direct testing of the verification / dispatch logic.
export { verifyCustomFields, dispatchLead, buildSaasClientConfig, ATLAS_SAAS_TWENTY_BASE_URL };
