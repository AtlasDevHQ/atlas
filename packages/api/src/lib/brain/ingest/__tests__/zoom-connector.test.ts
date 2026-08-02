/**
 * The Zoom transcript connector's factory contract (#4965).
 *
 * The gap this file closes was a CROSS-COMMIT one, and worth naming because it
 * is the shape that survives per-PR review. `slack-connector.test.ts` existed
 * before this milestone and `outlook-connector.test.ts` landed one commit AFTER
 * Zoom — so the connector in the middle shipped with no factory test at all,
 * while the commits on either side each established the pattern. Neither PR's
 * diff showed the hole.
 *
 * Mirrors `outlook-connector.test.ts` block for block, deliberately: these two
 * connectors are the same shape on the same seam, and a property worth pinning
 * for one is worth pinning for the other. Where the two genuinely differ — Zoom
 * clamps to a vendor RETENTION ceiling rather than a cost one, and its host list
 * is optional where Outlook's mailbox scope is required — the difference is
 * stated rather than silently dropped.
 *
 * The load-bearing test is `registers the connector AND its re-verifier`. That
 * pairing is the one whose regression is invisible: transcripts keep ingesting,
 * every sync stays green, and the meetings' `audience:` grants quietly stop
 * granting a week later when they cross the staleness bound.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

let SETTING: string | undefined;
// Mock-all-exports (CLAUDE.md): every VALUE export of `lib/settings.ts`. The
// module is imported for one getter, but a partial factory surfaces as "Export
// named 'X' not found" in whatever unrelated file happens to import the missing
// symbol next. Copied wholesale from `outlook-connector.test.ts` — keep in step.
void mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) =>
    key === "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS" ? SETTING : undefined,
  getSetting: (key: string) =>
    key === "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS" ? SETTING : undefined,
  getSettingLive: async (key: string) =>
    key === "ATLAS_BRAIN_TRANSCRIPT_BACKFILL_DAYS" ? SETTING : undefined,
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
 * Reaching into the logger rather than pinning source text, for the reason
 * `outlook-connector.test.ts` records: a source-text assertion that the catch
 * binds no `err` was evaded in review by renaming the parameter and
 * interpolating it into the MESSAGE string. A capture sees every argument of
 * every call, so neither dodge works.
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
  DEFAULT_TRANSCRIPT_BACKFILL_DAYS,
  MAX_TRANSCRIPT_BACKFILL_DAYS,
  createZoomTranscriptConnector,
  getTranscriptBackfillWindowMs,
  parseZoomAppCredential,
  registerZoomTranscriptConnector,
  resolveZoomToken,
} = await import("@atlas/api/lib/brain/ingest/zoom/connector");
const { ZOOM_TRANSCRIPTS_CATALOG_ID, ZOOM_TRANSCRIPT_SOURCE } = await import(
  "@atlas/api/lib/brain/ingest/zoom/config"
);
const { _resetBrainSourceConnectors, getBrainSourceConnector } = await import(
  "@atlas/api/lib/brain/ingest/types"
);
const { _resetAudienceReverifiers, listAudienceReverifierSources } = await import(
  "@atlas/api/lib/brain/audience/reverify"
);
type ZoomCredentialReader =
  import("@atlas/api/lib/brain/ingest/zoom/connector").ZoomCredentialReader;

const DAY_MS = 86_400_000;

afterEach(() => {
  SETTING = undefined;
  LOG_CALLS.length = 0;
  // `_resetBrainSourceConnectors` now clears the re-verifier registry too, so
  // one call is enough. `_resetAudienceReverifiers` stays for the same reason
  // the Outlook suite keeps it: this file must not depend on that coupling
  // holding, since the coupling is itself something under test elsewhere.
  _resetBrainSourceConnectors();
  _resetAudienceReverifiers();
});

describe("getTranscriptBackfillWindowMs", () => {
  it("defaults when the knob is unset or blank", () => {
    expect(getTranscriptBackfillWindowMs()).toBe(DEFAULT_TRANSCRIPT_BACKFILL_DAYS * DAY_MS);
    SETTING = "";
    expect(getTranscriptBackfillWindowMs()).toBe(DEFAULT_TRANSCRIPT_BACKFILL_DAYS * DAY_MS);
  });

  it("⭐ falls back on a NON-POSITIVE or unparseable window rather than backfilling nothing", () => {
    // A zero window makes the walk's floor equal its pass start: every
    // never-synced account reads an empty range, finds nothing, and reports
    // success forever. Green, and completely inert — the failure
    // `slack-connector.test.ts` was written for, which Zoom shipped without.
    //
    // MUTATION THIS CATCHES: dropping the `days <= 0` half of the guard.
    for (const raw of ["0", "-1", "abc", "NaN", " "]) {
      SETTING = raw;
      expect([raw, getTranscriptBackfillWindowMs()]).toEqual([
        raw,
        DEFAULT_TRANSCRIPT_BACKFILL_DAYS * DAY_MS,
      ]);
    }
  });

  it("clamps past the ceiling rather than failing the sync", () => {
    // Unlike Outlook's, this ceiling tracks a VENDOR bound — Zoom serves roughly
    // six months of cloud recordings — so asking for more is not merely
    // expensive, it is unanswerable. Still a clamp rather than an error: the
    // operator gets the most Zoom will give.
    SETTING = "5000";
    expect(getTranscriptBackfillWindowMs()).toBe(MAX_TRANSCRIPT_BACKFILL_DAYS * DAY_MS);
    // The boundary itself is NOT clamped, so the ceiling is reachable.
    SETTING = String(MAX_TRANSCRIPT_BACKFILL_DAYS);
    expect(getTranscriptBackfillWindowMs()).toBe(MAX_TRANSCRIPT_BACKFILL_DAYS * DAY_MS);
  });

  it("accepts a fractional window, for soak-testing", () => {
    SETTING = "0.5";
    expect(getTranscriptBackfillWindowMs()).toBe(0.5 * DAY_MS);
  });
});

describe("parseZoomAppCredential", () => {
  it("⭐ round-trips exactly what the install handler writes", () => {
    // The handler does `JSON.stringify({ clientId, clientSecret })`. This is the
    // ONLY thing pinning that cross-file agreement: rename either side and the
    // install still succeeds, then every sync fails with "re-install the
    // source" — advice that does not fix it.
    const written = JSON.stringify({ clientId: "cid", clientSecret: "shhh" });
    expect(parseZoomAppCredential(written)).toEqual({ clientId: "cid", clientSecret: "shhh" });
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
      expect([raw, parseZoomAppCredential(raw)]).toEqual([raw, null]);
    }
  });

  it("⭐ never lets the credential reach the log — the parse error ECHOES it", () => {
    // `JSON.parse("s3cr3t-client-secret")` throws `Unexpected identifier
    // "s3cr3t"`. `raw` here is the DECRYPTED credential blob, so logging
    // `err.message` ships a fragment of the client secret to the log sink for
    // any blob that is not JSON — a hand-repaired row, a legacy plaintext
    // secret, a partial decrypt.
    //
    // Outlook has this assertion; Zoom did not, despite the identical code path
    // and the identical blob.
    //
    // MUTATION THIS CATCHES: `log.warn({ err: ... })`, `log.warn({ raw })`, and
    // `log.warn({}, `...: ${raw}`)`.
    const secret = "SUPER-SECRET-CLIENT-VALUE";
    expect(parseZoomAppCredential(secret)).toBeNull();
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
    expect(parseZoomAppCredential(JSON.stringify({ clientId: "cid", other: secret }))).toBeNull();
    expect(JSON.stringify(LOG_CALLS)).not.toContain(secret);
  });

  it("trims, so a pasted credential with stray whitespace still works", () => {
    expect(parseZoomAppCredential(JSON.stringify({ clientId: " cid ", clientSecret: " s " }))).toEqual(
      { clientId: "cid", clientSecret: "s" },
    );
  });
});

describe("resolveZoomToken", () => {
  // Typed to the real interface rather than cast through `any`: these two
  // functions are the seam the install handler and the re-verifier also go
  // through, so a signature change should fail HERE rather than be absorbed.
  const reader = (overrides: Partial<ZoomCredentialReader> = {}): ZoomCredentialReader =>
    ({
      readSyncCredential: async () => JSON.stringify({ clientId: "cid", clientSecret: "s" }),
      fetchZoomAccessToken: async () => ({ ok: true as const, token: "tok" }),
      ...overrides,
    }) as ZoomCredentialReader;

  it("returns the token on the happy path", async () => {
    expect(await resolveZoomToken(reader(), "ws", "install", "acct")).toBe("tok");
  });

  it("names the CREDENTIAL when there is no readable one", async () => {
    await expect(
      resolveZoomToken(
        reader({ readSyncCredential: (async () => null) as ZoomCredentialReader["readSyncCredential"] }),
        "ws",
        "i",
        "a",
      ),
    ).rejects.toThrow(/no readable Zoom credential/);
  });

  it("⭐ gives each failure its OWN repair, because they are three different places", async () => {
    // Collapsing these sends an admin to rotate a secret that was fine, or to
    // inspect an app activation during a transient outage. Note the repairs
    // point at the ZOOM console — Outlook's point at Entra and Exchange, and an
    // operator sent to the wrong one has lost a support round-trip.
    //
    // MUTATION THIS CATCHES: folding the arms into one message.
    const cases: [string, RegExp][] = [
      ["invalid_auth", /client id, client secret, and account id/],
      ["transport", /usually transient/],
      ["plan_required", /Server-to-Server OAuth app is activated/],
    ];
    for (const [error, expected] of cases) {
      await expect(
        resolveZoomToken(
          reader({
            fetchZoomAccessToken: (async () => ({
              ok: false,
              error,
              retryAfterSeconds: null,
            })) as unknown as ZoomCredentialReader["fetchZoomAccessToken"],
          }),
          "ws",
          "i",
          "a",
        ),
      ).rejects.toThrow(expected);
    }
  });

  it("never puts the secret in the error it throws", async () => {
    // These messages land in `knowledge_sync_state.error`, which is
    // admin-readable — CLAUDE.md's no-secrets rule covers it.
    const thrown = await resolveZoomToken(
      reader({
        readSyncCredential: (async () =>
          JSON.stringify({
            clientId: "cid",
            clientSecret: "SUPER-SECRET-VALUE",
          })) as ZoomCredentialReader["readSyncCredential"],
        fetchZoomAccessToken: (async () => ({
          ok: false,
          error: "invalid_auth",
          retryAfterSeconds: null,
        })) as unknown as ZoomCredentialReader["fetchZoomAccessToken"],
      }),
      "ws",
      "i",
      "a",
    ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(thrown).not.toContain("SUPER-SECRET-VALUE");
    expect(thrown).not.toContain("cid");
  });
});

describe("the connector's factory contract", () => {
  it("declares the catalog id and the stored source kind", () => {
    const connector = createZoomTranscriptConnector();
    expect(connector.catalogId).toBe(ZOOM_TRANSCRIPTS_CATALOG_ID);
    expect(connector.source).toBe(ZOOM_TRANSCRIPT_SOURCE);
  });

  it("throws the CONFIG's own actionable error, not a shape error", () => {
    const connector = createZoomTranscriptConnector();
    expect(() =>
      connector.createClient({ workspaceId: "ws", installId: "i", config: {} }),
    ).toThrow(/no Zoom account id configured/);
  });

  it("accepts an ABSENT host list — unlike Outlook's mailbox scope, it is optional", () => {
    // The one place the two connectors' configs genuinely differ. Zoom's blank
    // host field means "the whole account" by design; Graph's application
    // `Mail.Read` is tenant-wide, so Outlook has no spelling that means
    // everything by omission and REQUIRES the scope. Pinned so a later
    // "consistency" edit does not make one behave like the other.
    const connector = createZoomTranscriptConnector();
    expect(() =>
      connector.createClient({ workspaceId: "ws", installId: "i", config: { accountId: "a" } }),
    ).not.toThrow();
  });

  it("⭐ DEFERS the token exchange, so it sits inside the engine's backoff", () => {
    // `createClient` runs before the shared rate-limit backoff wraps the fetch,
    // so a token exchange done at construction time would sit OUTSIDE the retry
    // it needs. Proven by constructing with a reader that REJECTS: if the
    // exchange were awaited here, this would throw.
    //
    // MUTATION THIS CATCHES: awaiting `resolveZoomToken` in `createClient`.
    const exploding = {
      readSyncCredential: async () => {
        throw new Error("must not be called at construction time");
      },
      fetchZoomAccessToken: async () => {
        throw new Error("must not be called at construction time");
      },
    } as unknown as ZoomCredentialReader;
    const connector = createZoomTranscriptConnector({ reader: exploding });
    expect(() =>
      connector.createClient({
        workspaceId: "ws",
        installId: "i",
        config: { accountId: "a", hosts: ["host@corp.test"] },
      }),
    ).not.toThrow();
  });
});

describe("registerZoomTranscriptConnector", () => {
  it("⭐ registers the connector AND its re-verifier, in one call", () => {
    // The single most load-bearing assertion in this file, and the one the
    // milestone shipped without. The coupling is the point: a deployment with
    // the connector and no re-verifier mints `audience:meeting:…` grants that
    // stop granting at the staleness bound a week later — silently, with every
    // sync green. `register.ts`'s own comment states this failure mode; nothing
    // proved it held.
    //
    // MUTATION THIS CATCHES: dropping the `registerZoomAudienceReverifier` call.
    // Nothing else in the suite would notice.
    expect(getBrainSourceConnector(ZOOM_TRANSCRIPTS_CATALOG_ID)).toBeUndefined();
    expect(listAudienceReverifierSources()).not.toContain(ZOOM_TRANSCRIPT_SOURCE);

    registerZoomTranscriptConnector();

    expect(getBrainSourceConnector(ZOOM_TRANSCRIPTS_CATALOG_ID)).toBeDefined();
    expect(listAudienceReverifierSources()).toContain(ZOOM_TRANSCRIPT_SOURCE);
  });

  it("is idempotent — a second call is a no-op, not a throw", () => {
    // `registerBuiltinInstallHandlers` runs at boot and from tests, and BOTH
    // registries throw on a duplicate. A second call that got past the gate
    // would abort registration part-way, leaving the connector registered and
    // the re-verifier permanently absent — which is exactly the un-re-verified
    // state the test above exists to prevent.
    registerZoomTranscriptConnector();
    expect(() => registerZoomTranscriptConnector()).not.toThrow();
    expect(
      listAudienceReverifierSources().filter((s) => s === ZOOM_TRANSCRIPT_SOURCE),
    ).toHaveLength(1);
  });
});
