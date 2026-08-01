/**
 * The Outlook mail connector's factory contract (#4966).
 *
 * Small surface, and three things on it fail SILENTLY if they regress — which is
 * why this file exists rather than leaning on the client tests:
 *
 *   - `getEmailBackfillWindowMs` guards against a non-positive window. A `0`
 *     makes `floorIso === passStartIso`, so every never-synced mailbox walks an
 *     empty range, returns nothing, and reports `coverageIncomplete: false` and
 *     `success` — a source that ingests nothing forever while rendering green.
 *     The guard is the only thing between a fat-fingered platform setting and
 *     that state. `slack-connector.test.ts` was written for this exact failure;
 *     Zoom shipped without the test, and this file stops that repeating.
 *   - `parseOutlookAppCredential` reads a JSON blob the INSTALL HANDLER writes.
 *     Nothing else pins that cross-file agreement, and if it breaks, installs
 *     succeed and every later sync fails with "re-install the source" — advice
 *     that does not fix it.
 *   - `resolveOutlookToken`'s three arms name three different repairs in three
 *     different places. Collapsing them sends an admin to inspect a
 *     configuration that was never wrong.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let SETTING: string | undefined;
// Mock-all-exports (CLAUDE.md): every VALUE export of `lib/settings.ts`. The
// module is imported for one getter, but a partial factory surfaces as "Export
// named 'X' not found" in whatever unrelated file happens to import the missing
// symbol next. Copied wholesale from `slack-connector.test.ts` — keep in step.
void mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) =>
    key === "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS" ? SETTING : undefined,
  getSetting: (key: string) => (key === "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS" ? SETTING : undefined),
  getSettingLive: async (key: string) =>
    key === "ATLAS_BRAIN_EMAIL_BACKFILL_DAYS" ? SETTING : undefined,
  getSettingOverride: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  refreshSettingsTick: async () => {},
  isHotReloadedKey: () => false,
  isSaasModeForGuard: () => false,
  securitySensitiveAuditFields: () => ({}),
  _resetSettingsCache: () => {},
  HOT_RELOADED_KEYS: new Set<string>(),
  SECURITY_SENSITIVE_KEYS: new Set<string>(),
}));

/**
 * Every `log.*` call this module makes, captured.
 *
 * Mock-all-exports over `lib/logger.ts`'s value exports. Reaching into the
 * logger rather than pinning source text, because the property under test is
 * "the secret does not reach the sink" and a source-text pin cannot express
 * that: the first version of this guard asserted the catch bound no `err` and
 * the payload object was `{}` — and was evaded, in review, by renaming the
 * parameter and interpolating it into the MESSAGE string instead. A capture sees
 * every argument of every call, so neither dodge works.
 */
const LOG_CALLS: unknown[][] = [];
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (value: unknown) => value,
  getLogger: () => createCapturingLogger(),
  createLogger: () => createCapturingLogger(),
  hashShareToken: (token: string) => token,
  setLogLevel: () => true,
}));

function createCapturingLogger(): Record<string, (...args: unknown[]) => void> {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      LOG_CALLS.push([level, ...args]);
    };
  return {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  };
}

// ⚠️ Both `mock.module` calls MUST precede the dynamic imports below.
// `connector.ts` binds its logger at MODULE SCOPE (`const log = createLogger(...)`),
// so a mock registered after the import captures nothing and the assertions
// silently pass against an empty capture.
const {
  DEFAULT_EMAIL_BACKFILL_DAYS,
  MAX_EMAIL_BACKFILL_DAYS,
  createOutlookMailConnector,
  getEmailBackfillWindowMs,
  parseOutlookAppCredential,
  registerOutlookMailConnector,
  resolveOutlookToken,
} = await import("@atlas/api/lib/brain/ingest/outlook/connector");
const { OUTLOOK_MAIL_CATALOG_ID, OUTLOOK_MAIL_SOURCE } = await import(
  "@atlas/api/lib/brain/ingest/outlook/config"
);
const { _resetBrainSourceConnectors, getBrainSourceConnector } = await import(
  "@atlas/api/lib/brain/ingest/types"
);
const { _resetAudienceReverifiers, listAudienceReverifierSources } = await import(
  "@atlas/api/lib/brain/audience/reverify"
);
type OutlookCredentialReader = import("@atlas/api/lib/brain/ingest/outlook/connector").OutlookCredentialReader;

const DAY_MS = 86_400_000;

afterEach(() => {
  SETTING = undefined;
  LOG_CALLS.length = 0;
  _resetBrainSourceConnectors();
  // ⚠️ BOTH registries. `registerOutlookMailConnector`'s idempotence gate reads
  // only the connector registry, so resetting that alone lets the gate pass on a
  // second call while `registerAudienceReverifier` throws on the duplicate —
  // aborting mid-registration with the connector already registered.
  _resetAudienceReverifiers();
});

describe("getEmailBackfillWindowMs", () => {
  it("defaults when the knob is unset or blank", () => {
    expect(getEmailBackfillWindowMs()).toBe(DEFAULT_EMAIL_BACKFILL_DAYS * DAY_MS);
    SETTING = "";
    expect(getEmailBackfillWindowMs()).toBe(DEFAULT_EMAIL_BACKFILL_DAYS * DAY_MS);
  });

  it("⭐ falls back on a NON-POSITIVE or unparseable window rather than backfilling nothing", () => {
    // A zero window makes `floorIso === passStartIso`: every never-synced mailbox
    // reads an empty range, finds nothing, and reports success forever. Green,
    // and completely inert.
    //
    // MUTATION THIS CATCHES: dropping the `days <= 0` half of the guard.
    for (const raw of ["0", "-1", "abc", "NaN", " "]) {
      SETTING = raw;
      expect([raw, getEmailBackfillWindowMs()]).toEqual([
        raw,
        DEFAULT_EMAIL_BACKFILL_DAYS * DAY_MS,
      ]);
    }
  });

  it("clamps past the ceiling rather than failing the sync", () => {
    // The ceiling is a COST bound, not a vendor one — Exchange really does hold
    // years — so an operator who asked for five years should get one year with a
    // warning, not an error.
    SETTING = "5000";
    expect(getEmailBackfillWindowMs()).toBe(MAX_EMAIL_BACKFILL_DAYS * DAY_MS);
    // The boundary itself is NOT clamped, so the ceiling is reachable.
    SETTING = String(MAX_EMAIL_BACKFILL_DAYS);
    expect(getEmailBackfillWindowMs()).toBe(MAX_EMAIL_BACKFILL_DAYS * DAY_MS);
  });

  it("accepts a fractional window, for soak-testing", () => {
    SETTING = "0.5";
    expect(getEmailBackfillWindowMs()).toBe(0.5 * DAY_MS);
  });
});

describe("parseOutlookAppCredential", () => {
  it("⭐ round-trips exactly what the install handler writes", () => {
    // The handler does `JSON.stringify({ clientId, clientSecret })`. This is the
    // ONLY thing pinning that cross-file agreement: rename either side and the
    // install still succeeds, then every sync fails with "no readable Microsoft
    // credential — re-install the source", which is advice that does not fix it.
    const written = JSON.stringify({ clientId: "cid", clientSecret: "shhh" });
    expect(parseOutlookAppCredential(written)).toEqual({ clientId: "cid", clientSecret: "shhh" });
  });

  it("returns null for every unreadable shape, without throwing", () => {
    for (const raw of [
      null,
      "",
      "not json",
      "[]",
      "null",
      '"a string"',
      "{}",
      JSON.stringify({ clientId: "cid" }),
      JSON.stringify({ clientSecret: "shhh" }),
      JSON.stringify({ clientId: "", clientSecret: "shhh" }),
      JSON.stringify({ clientId: "cid", clientSecret: "   " }),
      JSON.stringify({ clientId: 42, clientSecret: "shhh" }),
    ]) {
      expect([raw, parseOutlookAppCredential(raw)]).toEqual([raw, null]);
    }
  });

  it("⭐ never lets the credential reach the log — the parse error ECHOES it", () => {
    // `JSON.parse("s3cr3t-client-secret")` throws `Unexpected identifier
    // "s3cr3t"`. `raw` here is the DECRYPTED credential blob, so logging
    // `err.message` — the reflex, and what this code did until round 1 — ships a
    // fragment of the client secret to the log sink for any blob that is not
    // JSON: a hand-repaired row, a legacy plaintext secret, a partial decrypt.
    //
    // Asserted by CAPTURING the logger rather than by reading the source. Round
    // 2 evaded the source-text version by renaming the parameter and
    // interpolating it into the message string, which satisfied every textual
    // assertion while shipping the secret. A capture cannot be dodged that way:
    // it inspects every argument of every call.
    //
    // MUTATION THIS CATCHES: `log.warn({ err: ... })`, `log.warn({ raw })`, and
    // `log.warn({}, \`...: ${raw}\`)` — the last of which the first version missed.
    const secret = "SUPER-SECRET-CLIENT-VALUE";
    expect(parseOutlookAppCredential(secret)).toBeNull();
    expect(LOG_CALLS.length).toBeGreaterThan(0);
    const written = JSON.stringify(LOG_CALLS);
    expect(written).not.toContain(secret);
    // Not merely absent as a whole — no FRAGMENT either, which is what
    // `JSON.parse`'s message actually leaks ("Unexpected identifier \"SUPER\"").
    expect(written).not.toContain("SUPER");
    // …and the operator still gets something actionable out of it.
    expect(written).toContain("re-install");
  });

  it("does not log the blob on the SHAPE-failure path either", () => {
    // A well-formed JSON object missing a field never reaches the catch, so the
    // guard above says nothing about it. It is the same blob.
    const secret = "ANOTHER-SECRET-VALUE";
    expect(parseOutlookAppCredential(JSON.stringify({ clientId: "cid", other: secret }))).toBeNull();
    expect(JSON.stringify(LOG_CALLS)).not.toContain(secret);
  });

  it("trims, so a pasted credential with stray whitespace still works", () => {
    expect(parseOutlookAppCredential(JSON.stringify({ clientId: " cid ", clientSecret: " s " })))
      .toEqual({ clientId: "cid", clientSecret: "s" });
  });
});

describe("resolveOutlookToken", () => {
  // Typed to the real interface rather than cast through `any`: these two
  // functions are the seam the install handler and the re-verifier also go
  // through, so a signature change should fail HERE rather than be absorbed.
  const reader = (overrides: Partial<OutlookCredentialReader> = {}): OutlookCredentialReader => ({
    readSyncCredential: async () => JSON.stringify({ clientId: "cid", clientSecret: "s" }),
    fetchGraphAccessToken: async () => ({ ok: true as const, token: "tok" }),
    ...overrides,
  });

  it("returns the token on the happy path", async () => {
    expect(await resolveOutlookToken(reader(), "ws", "install", "tenant")).toBe("tok");
  });

  it("names the CREDENTIAL when there is no readable one", async () => {
    await expect(
      resolveOutlookToken(reader({ readSyncCredential: async () => null }), "ws", "i", "t"),
    ).rejects.toThrow(/no readable Microsoft credential/);
  });

  it("⭐ gives each failure its OWN repair, because they are three different places", async () => {
    // Collapsing these sends an admin to rotate a secret that was fine, or to
    // inspect an app registration during a transient outage.
    //
    // MUTATION THIS CATCHES: folding the arms into one message.
    const cases: [string, RegExp][] = [
      // A rejected credential — check the id/secret/tenant, and note that Entra
      // secrets EXPIRE, which is the cause an admin will not think of.
      ["invalid_auth", /client secret has not expired/],
      // Transient — do not send anyone to a console at all.
      ["transport", /usually transient/],
      // Anything else — the permission grant is the likely cause.
      ["missing_scope", /Mail\.Read application permission with admin consent/],
    ];
    for (const [error, expected] of cases) {
      await expect(
        resolveOutlookToken(
          reader({
            fetchGraphAccessToken: async () => ({ ok: false, error, retryAfterSeconds: null }),
          }),
          "ws",
          "i",
          "t",
        ),
      ).rejects.toThrow(expected);
    }
  });

  it("never puts the secret in the error it throws", async () => {
    // These messages land in `knowledge_sync_state.error`, which is
    // admin-readable — CLAUDE.md's no-secrets rule covers it.
    const thrown = await resolveOutlookToken(
      reader({
        readSyncCredential: async () =>
          JSON.stringify({ clientId: "cid", clientSecret: "SUPER-SECRET-VALUE" }),
        fetchGraphAccessToken: async () => ({
          ok: false,
          error: "invalid_auth",
          retryAfterSeconds: null,
        }),
      }),
      "ws",
      "i",
      "t",
    ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(thrown).not.toContain("SUPER-SECRET-VALUE");
    expect(thrown).not.toContain("cid");
  });
});

describe("the connector's factory contract", () => {
  it("declares the catalog id and the stored source kind", () => {
    const connector = createOutlookMailConnector();
    expect(connector.catalogId).toBe(OUTLOOK_MAIL_CATALOG_ID);
    expect(connector.source).toBe(OUTLOOK_MAIL_SOURCE);
  });

  it("throws the CONFIG's own actionable error, not a shape error", () => {
    const connector = createOutlookMailConnector();
    expect(() =>
      connector.createClient({ workspaceId: "ws", installId: "i", config: { tenantId: "t" } }),
    ).toThrow(/no setting that means every mailbox/);
  });

  it("⭐ DEFERS the token exchange, so it sits inside the engine's backoff", () => {
    // `createClient` runs before the shared rate-limit backoff wraps the fetch,
    // so a token exchange done at construction time would sit OUTSIDE the retry
    // it needs. Proven by constructing with a reader that REJECTS: if the
    // exchange were awaited here, this would throw.
    //
    // MUTATION THIS CATCHES: awaiting `resolveOutlookToken` in `createClient`.
    const exploding: OutlookCredentialReader = {
      readSyncCredential: async () => {
        throw new Error("must not be called at construction time");
      },
      fetchGraphAccessToken: async () => {
        throw new Error("must not be called at construction time");
      },
    };
    const connector = createOutlookMailConnector({ reader: exploding });
    expect(() =>
      connector.createClient({
        workspaceId: "ws",
        installId: "i",
        config: { tenantId: "t", mailboxes: ["a@contoso.com"] },
      }),
    ).not.toThrow();
  });
});

describe("registerOutlookMailConnector", () => {
  it("⭐ registers the connector AND its re-verifier, in one call", () => {
    // The coupling is the point: a deployment with the connector and no
    // re-verifier mints `audience:` grants that stop granting at the staleness
    // bound a week later, silently, with every sync green.
    //
    // MUTATION THIS CATCHES: dropping the `registerOutlookAudienceReverifier`
    // call. Nothing else in the suite would notice.
    expect(getBrainSourceConnector(OUTLOOK_MAIL_CATALOG_ID)).toBeUndefined();
    expect(listAudienceReverifierSources()).not.toContain(OUTLOOK_MAIL_SOURCE);

    registerOutlookMailConnector();

    expect(getBrainSourceConnector(OUTLOOK_MAIL_CATALOG_ID)).toBeDefined();
    expect(listAudienceReverifierSources()).toContain(OUTLOOK_MAIL_SOURCE);
  });

  it("is idempotent — a second call is a no-op, not a throw", () => {
    // `registerBuiltinInstallHandlers` runs at boot and from tests, and BOTH
    // registries throw on a duplicate. A second call that got past the gate
    // would abort registration part-way and silently leave every handler after
    // this line unregistered.
    registerOutlookMailConnector();
    expect(() => registerOutlookMailConnector()).not.toThrow();
    expect(listAudienceReverifierSources().filter((s) => s === OUTLOOK_MAIL_SOURCE)).toHaveLength(
      1,
    );
  });
});
