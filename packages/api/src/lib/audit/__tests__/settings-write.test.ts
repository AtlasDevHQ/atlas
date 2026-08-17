/**
 * #5270 / #5262 — the settings-write audit seam.
 *
 * Three claims, and they fail in different places, so they are asserted
 * separately rather than through one "the entry looks right" check:
 *
 *  1. a `secret: true` value never reaches `admin_action_log.metadata`
 *  2. a platform-tier write is stamped `scope: "platform"`, so it stays off
 *     the org-scoped `/admin/admin-actions` read API
 *  3. the row is AWAITED — a rejection propagates to the caller instead of
 *     being dropped silently (the mechanism is in `settings-write.ts`'s
 *     header; #5262's stated one was measured false)
 *
 * ⚠️ CLAIM 1 NEEDS A REGISTRY KEY THAT IS ACTUALLY `secret: true`, and it
 * needs redacted and raw to DIFFER on it. This is the trap #5180 documented:
 * for a key whose value is not secret, the redacted and raw strings are
 * identical, so an assertion comparing them passes under a fix and under its
 * removal alike. The WITHHOLDING tests therefore drive `RESEND_API_KEY`'s real
 * `secret: true` entry with a value visibly unlike the placeholder; their
 * controls drive `ATLAS_MODEL`'s non-secret entry, and the empty-secret case
 * drives `""` on purpose.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";

interface AwaitedEntry {
  readonly actionType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly scope?: string;
  readonly metadata?: Record<string, unknown>;
  readonly ipAddress?: string | null;
}

const awaited: AwaitedEntry[] = [];
const fireAndForget: AwaitedEntry[] = [];
let awaitRejectsWith: Error | undefined;

/**
 * ⚠️ BOTH SINKS, kept apart on purpose. A single "was the audit called" array
 * cannot see `logAdminActionAwait` swapped back to `logAdminAction` — which is
 * exactly defect (3), and which no assertion on the metadata would notice
 * because the entry is byte-identical either way.
 */
void mock.module("@atlas/api/lib/audit/admin", () => ({
  logAdminAction: (entry: AwaitedEntry) => {
    fireAndForget.push(entry);
  },
  logAdminActionAwait: async (entry: AwaitedEntry) => {
    awaited.push(entry);
    if (awaitRejectsWith) throw awaitRejectsWith;
  },
}));

/**
 * ⚠️ ONE SINK CARRYING THE LEVEL, for the same reason the seeder collision
 * suite has one: a per-level array cannot see a `log.warn` demoted to
 * `log.info`, and the mismatch guard's ENTIRE operator-visible signal is its
 * level. Mock-all-exports per the repo rule.
 */
interface LoggedCall {
  readonly level: "info" | "warn" | "error" | "debug";
  readonly payload: unknown;
  readonly message: string;
}
const logged: LoggedCall[] = [];
const record =
  (level: LoggedCall["level"]) =>
  (payload: unknown, message?: string): void => {
    logged.push({
      level,
      payload,
      message: typeof payload === "string" ? payload : (message ?? ""),
    });
  };
const stubLogger = {
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  debug: record("debug"),
};
void mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  getRequestContext: () => undefined,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: () => "",
  setLogLevel: () => false,
}));

const { auditSettingsWrite } = await import("@atlas/api/lib/audit/settings-write");
const { getSettingDefinition } = await import("@atlas/api/lib/settings");

/** A real `secret: true`, `scope: "platform"` registry entry. */
const SECRET_DEF = getSettingDefinition("RESEND_API_KEY");
/** A real non-secret entry, so the verbatim arm is exercised against the registry too. */
const PLAIN_DEF = getSettingDefinition("ATLAS_MODEL");

/**
 * One key per RULE (#5262): the abuse threshold, plus both alias knobs, which
 * have separate rules. The two families weaken in opposite directions — a LOW
 * abuse threshold disables a control, a WIDE alias source list grants authority,
 * and each family's other flag is structurally always `false` — so a single
 * fixture would leave rules unexercised and could not tell a per-key rule table
 * from one rule applied to everything.
 */
const RPM_KEY = "ATLAS_TRIAL_IP_RATE_LIMIT_RPM";
const SOURCES_KEY = "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES";
const THRESHOLD_KEY = "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD";
const RPM_DEF = getSettingDefinition(RPM_KEY);
const SOURCES_DEF = getSettingDefinition(SOURCES_KEY);
const THRESHOLD_DEF = getSettingDefinition(THRESHOLD_KEY);

// ⚠️ Deliberately NOT a real provider prefix. `re_live_…` is Resend's live-key
// shape and GitHub push protection scans for it — a fabricated value that trips
// a secret scanner costs a CI round for nothing.
const SECRET_VALUE = "resend_fake_51H8xQ2eZvKYlo2C_not_a_placeholder";
const WITHHELD = "[withheld:secret-setting]";

const lastAwaited = (): AwaitedEntry => {
  const last = awaited[awaited.length - 1];
  // Diagnostic rather than a `TypeError` several frames away: reaching here with
  // an empty array means the test exercised the no-DB arm (or 404'd) and every
  // `meta()` assertion below it is about a row that was never recorded.
  if (!last) throw new Error("no audit row was awaited — did this test reach the no-internal-DB arm?");
  return last;
};
const meta = (): Record<string, unknown> => lastAwaited().metadata ?? {};

let savedDbUrl: string | undefined;

describe("auditSettingsWrite", () => {
  beforeEach(() => {
    awaited.length = 0;
    fireAndForget.length = 0;
    logged.length = 0;
    awaitRejectsWith = undefined;
    // ⚠️ `auditSettingsWrite` returns EARLY without a row when
    // `hasInternalDB()` is false, and that is a pure
    // `!!process.env.DATABASE_URL` read. Unit runs have no DATABASE_URL, so
    // without this every test in this file exercises the no-DB arm and
    // asserts against an entry that was never recorded — which is exactly
    // what happened when the guard was added. Set per-test and restored in
    // `afterEach`, never at module scope (the repo's self-containment rule).
    savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://unit-test/not-connected";
  });

  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it("the fixture is sound — the registry entries this file relies on are what it claims", () => {
    // Without this the whole suite could be asserting against `undefined`
    // definitions, which land in `redactAuditValue`'s fail-closed arm and
    // would make claim 1 pass for the wrong reason.
    expect(SECRET_DEF?.secret).toBe(true);
    expect(SECRET_DEF?.scope).toBe("platform");
    // ⚠️ `toBeDefined` FIRST. `expect(PLAIN_DEF?.secret).toBeFalsy()` passes
    // when `PLAIN_DEF` is `undefined` — the optional chain yields `undefined`,
    // which is falsy — so a renamed registry key would make this file assert
    // against a missing definition and every "verbatim arm" test below would
    // pass through the fail-closed arm instead. That is the exact
    // passes-for-the-wrong-reason class this block exists to prevent.
    expect(PLAIN_DEF).toBeDefined();
    expect(PLAIN_DEF?.secret).toBeFalsy();
    // ⚠️ The rule fixtures are guarded HERE, not inside the describe that uses
    // them. `describe("3 — the await")` also drives `RPM_DEF`, and would have
    // passed with it `undefined` (the flags derive from `entry.key`, not the
    // definition) — so a guard living in describe 4 covered the file only by
    // accident of ordering.
    for (const [k, def] of [
      [RPM_KEY, RPM_DEF],
      [SOURCES_KEY, SOURCES_DEF],
      [THRESHOLD_KEY, THRESHOLD_DEF],
    ] as const) {
      expect(def, `no registry definition for ${k}`).toBeDefined();
    }
  });

  describe("1 — the value", () => {
    it("⭐ withholds a `secret: true` value instead of recording it verbatim", async () => {
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: SECRET_DEF,
        value: SECRET_VALUE,
        action: "update",
        platformTier: true,
        ipAddress: null,
      });

      expect(meta().value).toBe(WITHHELD);
      expect(meta().valueMasked).toBe(true);
      expect(meta().maskReason).toBe("secret");
      // ⚠️ THE NEGATIVE TOO, and not only on `metadata.value`: the whole
      // serialized entry, because a future field ("previousValue",
      // "diff", …) that carried the plaintext would satisfy the assertion
      // above and still be the breach.
      expect(JSON.stringify(lastAwaited())).not.toContain(SECRET_VALUE);
    });

    it("records a non-secret value verbatim — the arm that must NOT be withheld", async () => {
      // The other half of the claim. A module that withheld unconditionally
      // would pass the test above and destroy the audit trail's usefulness.
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().value).toBe("claude-opus-5");
      expect(meta().valueMasked).toBe(false);
      expect(meta().maskReason).toBeUndefined();
    });

    it("fails closed on a key with no registry definition", async () => {
      // "We could not tell whether it is secret" is not a licence to print.
      await auditSettingsWrite({
        key: "ATLAS_SOMETHING_RENAMED",
        definition: undefined,
        value: SECRET_VALUE,
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().value).toBe(WITHHELD);
      expect(meta().maskReason).toBe("unknown_definition");
      expect(JSON.stringify(lastAwaited())).not.toContain(SECRET_VALUE);
    });

    it("⭐ withholds when the definition belongs to a DIFFERENT key", async () => {
      // The cheap defeat of the brand, and this module shipped without the
      // guard its #5180 sibling has. The brand fences the OUTPUT of the
      // redaction decision; corrupting its INPUT needs no cast. A real
      // definition for the wrong key is far easier to produce than the
      // fabricated one #5180 reasoned about — an alias or rename resolver
      // hands you one.
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: PLAIN_DEF, // ATLAS_MODEL's entry: secret: false
        value: SECRET_VALUE,
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().value).toBe(WITHHELD);
      expect(meta().valueMasked).toBe(true);
      // ⚠️ The REASON, not just the withholding. "registry drift" and "the
      // call site passed the wrong entry" send an operator to different
      // places — which is why `AuditMaskReason` has three arms and not two.
      // This module advertised `definition_mismatch` in its type while being
      // unable to produce it.
      expect(meta().maskReason).toBe("definition_mismatch");
      expect(JSON.stringify(lastAwaited())).not.toContain(SECRET_VALUE);
    });

    it("⭐ WARNS on a mismatch — the event is not left to one JSONB field", async () => {
      // Round 1 recorded the mismatch only in `metadata.maskReason`: one field
      // of one audit row, which nothing alerts on and nobody greps. A
      // definition that does not belong to its key is a PROGRAMMER bug —
      // registry drift, an alias resolver, a `def` reused across keys in a
      // loop — and detecting it while saying nothing is the swallow this
      // module's header is about.
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: PLAIN_DEF,
        value: SECRET_VALUE,
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      const warns = logged.filter((c) => c.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.payload).toMatchObject({
        key: "RESEND_API_KEY",
        definitionKey: "ATLAS_MODEL",
        maskReason: "definition_mismatch",
      });
      // The message must say it is a CALLER bug, not a data condition — the
      // remedy is different and the operator reads the message.
      expect(warns[0]?.message).toContain("caller bug");
      // ⚠️ And the warn must not carry the value it just withheld.
      expect(JSON.stringify(warns[0])).not.toContain(SECRET_VALUE);
    });

    it("⭐ WARNS on a mismatch even on reset_to_default, where there is no value to mark", async () => {
      // The arm round 1's fix could not reach at all: with `value: undefined`
      // the whole metadata block is skipped, so `mismatched` was computed,
      // found true, and DISCARDED. A clear filed against the wrong registry
      // entry was indistinguishable from a correct one.
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: PLAIN_DEF,
        action: "reset_to_default",
        platformTier: true,
        ipAddress: null,
      });
      const warns = logged.filter((c) => c.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.payload).toMatchObject({ action: "reset_to_default" });
      // No value field exists to carry `maskReason`, which is precisely why
      // the log line has to.
      expect("value" in meta()).toBe(false);
      expect("maskReason" in meta()).toBe(false);
    });

    it("does NOT warn when the definition matches — the discriminating half", async () => {
      // A guard that warned unconditionally would pass both tests above and
      // fill the stream with noise on every settings write.
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(logged.filter((c) => c.level === "warn")).toHaveLength(0);
    });

    it("a definition whose key MATCHES is still used — the guard is not a blanket withhold", async () => {
      // The discriminating half. A guard that discarded every definition
      // would pass the test above and withhold every value in the product.
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().value).toBe("claude-opus-5");
      expect(meta().maskReason).toBeUndefined();
    });

    it("withholds the EMPTY secret like any other — no one-bit oracle", async () => {
      // `value: undefined` where every other secret reads `[withheld…]` would
      // disclose the empty secret exactly. `action` carries set-vs-clear.
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: SECRET_DEF,
        value: "",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().value).toBe(WITHHELD);
      expect(meta().valueMasked).toBe(true);
    });

    it("the reset_to_default path carries NO value field at all", async () => {
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: SECRET_DEF,
        value: undefined,
        action: "reset_to_default",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().action).toBe("reset_to_default");
      expect("value" in meta()).toBe(false);
      expect("valueMasked" in meta()).toBe(false);
    });
  });

  describe("2 — the scope", () => {
    it("⭐ stamps a platform-tier write `scope: \"platform\"`", async () => {
      // The default is "workspace" for any non-systemActor write, which put
      // these rows on the org-scoped `/admin/admin-actions` read API. The
      // entry must say platform EXPLICITLY, not rely on the default.
      await auditSettingsWrite({
        key: "RESEND_API_KEY",
        definition: SECRET_DEF,
        value: SECRET_VALUE,
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(lastAwaited().scope).toBe("platform");
      expect(meta().tier).toBe("platform");
    });

    it("leaves a workspace-tier write `scope: \"workspace\"`", async () => {
      // The discriminating half: a module that hardcoded "platform" would
      // hide genuine workspace settings activity from the workspace's own
      // audit view, which is a different bug in the opposite direction.
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: false,
        ipAddress: null,
      });
      expect(lastAwaited().scope).toBe("workspace");
      expect(meta().tier).toBe("workspace");
    });

    it("scope and tier agree — one fact, not two that can drift", async () => {
      for (const platformTier of [true, false]) {
        await auditSettingsWrite({
          key: "ATLAS_MODEL",
          definition: PLAIN_DEF,
          value: "x",
          action: "update",
          platformTier,
          ipAddress: null,
        });
        expect(lastAwaited().scope).toBe(meta().tier as string);
      }
    });
  });

  describe("3 — the await", () => {
    it("⭐ uses the AWAITING variant, never fire-and-forget", async () => {
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(awaited).toHaveLength(1);
      // ⚠️ Different lengths (1 vs 0), so the two sinks cannot be swapped
      // without a count disagreeing.
      expect(fireAndForget).toHaveLength(0);
      // ⚠️ THE LEVEL, not just the message. The COMMITTED line's whole argument
      // for being `info` rather than `debug` is that an operator greps it to
      // tell a committed row from an emitted-then-lost one — and the only other
      // assertion on it filters by message across every level, so a demotion to
      // `debug` (off in production) went unnoticed.
      expect(
        logged.filter((c) => c.level === "info" && c.message.includes("COMMITTED")),
      ).toHaveLength(1);
    });

    it("⭐ says NOT PERSISTED rather than COMMITTED when there is no internal DB", async () => {
      // `logAdminActionAwait` resolves without inserting when the internal DB
      // is absent, so the post-commit line would otherwise announce a row
      // that was never written. Unreachable through today's two callers
      // (both 404 first), but the header invites three more writers to adopt
      // this seam, and a log line confidently naming a nonexistent row is
      // worse than no line.
      // ⚠️ `hasInternalDB()` is a pure `!!process.env.DATABASE_URL` read, so
      // this needs no module mock — which matters, because a PARTIAL
      // `mock.module("@atlas/api/lib/db/internal")` replaces every one of its
      // exports and breaks `lib/settings.ts`'s `internalQuery` import several
      // files away from the cause. Measured: that is exactly what happened on
      // the first draft of this test.
      delete process.env.DATABASE_URL;
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(awaited).toHaveLength(0);
      const warns = logged.filter((c) => c.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.message).toContain("NOT persisted");
      expect(logged.filter((c) => c.message.includes("COMMITTED"))).toHaveLength(0);
    });

    it("⭐ the no-DB warn carries the judgement AND its caveat, not the flags alone", async () => {
      // The arm a fix-vs-finding pass caught one branch over from the fix: this
      // path spread the rule flags without `judgement`, so on a sensitive CLEAR
      // it emitted `disablesControl: false` — the exoneration the marker exists
      // to prevent — on the one path that has no durable row to correct it.
      //
      // ⚠️ A CLEAR of a SENSITIVE key, both at once. An update would carry no
      // marker by design, and a non-sensitive key would carry no flags, so
      // either alone passes whether or not the caveat travels.
      delete process.env.DATABASE_URL;
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        action: "reset_to_default",
        platformTier: true,
        ipAddress: null,
      });
      expect(awaited).toHaveLength(0);
      const warns = logged.filter((c) => c.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.payload).toMatchObject({
        disablesControl: false,
        judgement: "reverted_value_not_evaluated",
      });
    });

    it("⭐ propagates a rejection instead of swallowing it", async () => {
      // The whole point of the await: when the row cannot be committed the
      // caller has to find out. `logAdminAction` drops it instead — and past
      // an open circuit breaker it does so with NO log line at any level
      // (`db/internal.ts`), leaving only an anonymous counter. See the
      // module header; do not restate the mechanism here, restatements are
      // what went stale last round.
      awaitRejectsWith = new Error("circuit breaker open");
      await expect(
        auditSettingsWrite({
          key: "ATLAS_MODEL",
          definition: PLAIN_DEF,
          value: "claude-opus-5",
          action: "update",
          platformTier: true,
          ipAddress: null,
        }),
      ).rejects.toThrow(/circuit breaker open/);
      // ⚠️ AND NOTHING CLAIMED THE ROW LANDED. The line is `info` and sits after
      // the await for exactly this input; moving it above the await would make
      // the stream confidently name a row that was rolled back, and asserting
      // only the rejection cannot see that.
      expect(logged.filter((c) => c.message.includes("COMMITTED"))).toHaveLength(0);
    });
  });

  describe("4 — the judgement (#5262)", () => {
    it("the family fixtures are real registry entries and are actually sensitive", async () => {
      // Without this the whole block could be asserting that a MISSPELLED key
      // records no flags — which is what "absence is meaningful" looks like
      // from the outside, so every test below would pass for the wrong reason.
      const { SECURITY_SENSITIVE_KEYS } = await import("@atlas/api/lib/settings");
      for (const key of [RPM_KEY, SOURCES_KEY, THRESHOLD_KEY]) {
        expect(SECURITY_SENSITIVE_KEYS.has(key)).toBe(true);
      }
      // And the control key must be OUTSIDE the set, or the absence tests below
      // would be asserting absence against a key that has a rule.
      expect(SECURITY_SENSITIVE_KEYS.has("ATLAS_MODEL")).toBe(false);
    });

    it("⭐ records disablesControl on an abuse threshold written to its disabled sentinel", async () => {
      // The durable row now carries the ANALYSIS, not just the fact. Before
      // this, `admin_action_log` could say "someone set this to 0" and only the
      // suppressible pino line said "that disabled an abuse control".
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        value: "0",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().disablesControl).toBe(true);
      // ⚠️ The OTHER flag asserted too, and asserted `false` rather than
      // ignored: the abuse family has no notion of widening, so a rule table
      // wired to one shared rule would light both here.
      expect(meta().widensAuthority).toBe(false);
    });

    it("the fully-populated sensitive arm has EXACTLY these fields", async () => {
      // The metadata is four conditional spreads; every other test here reads
      // one field, so a stray or clobbered field on this path is invisible. One
      // `toEqual` pins the whole union cheaply — and would have caught the
      // `judgement` marker leaking onto the update path.
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        value: "0",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta()).toEqual({
        key: RPM_KEY,
        tier: "platform",
        value: "0",
        valueMasked: false,
        disablesControl: true,
        widensAuthority: false,
      });
      // ⚠️ THE KEY SET TOO, because `toEqual` IGNORES keys whose value is
      // `undefined` — so dropping the `!== undefined` guard on the `action`
      // spread gives every update row `action: undefined` and the assertion
      // above stays green. Production-inert (`JSON.stringify` drops it) but the
      // test's NAME claims exactness, and a test that claims more than it checks
      // is the thing this PR is about.
      expect(Object.keys(meta()).sort()).toEqual([
        "disablesControl",
        "key",
        "tier",
        "value",
        "valueMasked",
        "widensAuthority",
      ]);
    });

    it("⭐ records widensAuthority on an alias source list naming a class beyond warehouse_key", async () => {
      // The opposite direction, and the reason the rules are per-key: reusing
      // the numeric rule here would flag the SAFEST possible alias write (an
      // empty list — everything queues for review) as a disable.
      await auditSettingsWrite({
        key: SOURCES_KEY,
        definition: SOURCES_DEF,
        value: "warehouse_key,extractor",
        action: "update",
        platformTier: false,
        ipAddress: null,
      });
      expect(meta().widensAuthority).toBe(true);
      expect(meta().disablesControl).toBe(false);
    });

    it("records widensAuthority when the alias confidence bar drops below the shipped 1", async () => {
      await auditSettingsWrite({
        key: THRESHOLD_KEY,
        definition: THRESHOLD_DEF,
        value: "0.5",
        action: "update",
        platformTier: false,
        ipAddress: null,
      });
      expect(meta().widensAuthority).toBe(true);
      expect(meta().disablesControl).toBe(false);
    });

    // ⚠️ THE DISCRIMINATING HALF, per family. A seam that hardcoded either flag
    // to `true` would pass all three tests above and make the field useless in
    // the other direction — every settings write would read as a weakening.
    it("records both flags FALSE on a harmless write to a sensitive key", async () => {
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        value: "5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().disablesControl).toBe(false);
      expect(meta().widensAuthority).toBe(false);

      await auditSettingsWrite({
        key: SOURCES_KEY,
        definition: SOURCES_DEF,
        value: "warehouse_key",
        action: "update",
        platformTier: false,
        ipAddress: null,
      });
      expect(meta().disablesControl).toBe(false);
      expect(meta().widensAuthority).toBe(false);
    });

    // ⚠️ ABSENCE, NOT `false` — the control #5262 names explicitly. A row that
    // always carried `disablesControl: false` cannot be filtered on:
    // `WHERE metadata->>'disablesControl' = 'false'` would match every settings
    // write in the table. Absence must mean "no rule applies"; `false` must
    // mean "a rule ran and said no". `in`, not `toBeUndefined()` — a present
    // key with an `undefined` value satisfies the latter and still serializes
    // into the row.
    it("⭐ records NEITHER flag for a key outside the sensitive set", async () => {
      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        value: "claude-opus-5",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect("disablesControl" in meta()).toBe(false);
      expect("widensAuthority" in meta()).toBe(false);
      // And nothing snuck in through the serialized row either.
      expect(JSON.stringify(lastAwaited())).not.toContain("disablesControl");
    });

    // ⚠️ THE ACTION MAPPING, DRIVEN FROM EACH FAMILY on the `update` side —
    // which is the only side where a swap is visible. Measured: with
    // `value: undefined` on the reset path, all three rules return false/false
    // whichever action they are handed, so a clear-path assertion cannot fail
    // under a swapped mapping. The blind axis is the VERB, not the family.
    it("⭐ maps `update` to the rule engine's `set`, on both families", async () => {
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        value: "0",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      // `"0"` only disables under `set`; under `clear` the abuse rule
      // short-circuits and reports nothing weakened.
      expect(meta().disablesControl).toBe(true);

      await auditSettingsWrite({
        key: SOURCES_KEY,
        definition: SOURCES_DEF,
        value: "warehouse_key,extractor",
        action: "update",
        platformTier: false,
        ipAddress: null,
      });
      // Likewise: the source list only widens under `set`.
      expect(meta().widensAuthority).toBe(true);
    });

    it("⭐ marks a sensitive CLEAR as un-judged, so `false` cannot read as an exoneration", async () => {
      // The rules judge the WRITTEN value and a clear has none, so they return
      // false/false on every key — accurate about the rule, and read by an
      // operator as "this write weakened nothing". It can be the opposite:
      // clearing a "10" override on the RPM key while the env var holds "0"
      // turns the per-IP limiter OFF, and the row said disablesControl: false.
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        action: "reset_to_default",
        platformTier: true,
        ipAddress: null,
      });
      // ⚠️ THE WHOLE ARM, not field-by-field. This is the shape this PR ADDED and
      // it is the widest one the seam produces, so it earns the exact-shape check
      // its update sibling has. It also pins that a clear carries NO `value` —
      // asserted elsewhere only for a secret key, not for a sensitive one — and
      // that the flags are deliberately still present and still `false`, because
      // both sinks share `securitySensitiveAuditFields` and changing them would
      // move the pino line's #3797/#5161 semantics. The marker is additive.
      expect(meta()).toEqual({
        key: RPM_KEY,
        tier: "platform",
        action: "reset_to_default",
        disablesControl: false,
        widensAuthority: false,
        judgement: "reverted_value_not_evaluated",
      });
    });

    it("⭐ does NOT mark an update, nor a clear of a non-sensitive key", async () => {
      // The discriminating half, on both axes. A marker on every row is a marker
      // on nothing: the incident query
      //   WHERE disablesControl = 'true' OR judgement = 'reverted_value_not_evaluated'
      // would return every settings write in the table.
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        value: "0",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect("judgement" in meta()).toBe(false);

      await auditSettingsWrite({
        key: "ATLAS_MODEL",
        definition: PLAIN_DEF,
        action: "reset_to_default",
        platformTier: true,
        ipAddress: null,
      });
      expect("judgement" in meta()).toBe(false);
    });

    it("⭐ the row carries EVERY field the rule engine returns", async () => {
      // ⚠️ A DORMANT TRIPWIRE. Deriving the expected key set from the real
      // function's own output makes the assertion track the interface the same
      // way the builder's spread does — no mocking needed.
      //
      // It goes RED when a REQUIRED flag joins `SecuritySensitiveAudit` and the
      // builder has stopped spreading `ruleFlags` whole. That is #5262's own
      // asymmetry, which this PR reproduced once, one field over.
      //
      // ⚠️ Two cases survive, and the precondition is worth naming because it is
      // load-bearing: this reads the flags THIS key's rule returns, so a flag
      // added optionally, or one only the alias rules populate, never enters the
      // key set. It works today because `SecuritySensitiveRule` returns
      // `SecuritySensitiveAudit` with required properties, forcing every rule to
      // carry a new flag. The other survivor is the spelling revert with no new
      // flag — the key sets agree then, and only re-reading the seam catches it.
      const { securitySensitiveAuditFields } = await import("@atlas/api/lib/settings");
      const fields = securitySensitiveAuditFields(RPM_KEY, "set", "0");
      expect(fields).not.toBeNull();
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: RPM_DEF,
        value: "0",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      for (const k of Object.keys(fields ?? {})) expect(meta()).toHaveProperty(k);
    });

    it("maps `reset_to_default` to `clear`, which flags nothing on either family", async () => {
      // A clear reverts to a platform override that may itself be wide, so the
      // written value does not determine the outcome — both flags are `false`,
      // and PRESENT, because a rule did run.
      for (const [key, definition] of [
        [RPM_KEY, RPM_DEF],
        [SOURCES_KEY, SOURCES_DEF],
      ] as const) {
        await auditSettingsWrite({
          key,
          definition,
          action: "reset_to_default",
          platformTier: false,
          ipAddress: null,
        });
        expect(meta().disablesControl).toBe(false);
        expect(meta().widensAuthority).toBe(false);
        expect(meta().action).toBe("reset_to_default");
      }
    });

    it("⭐ records the judgement even when the VALUE is withheld", async () => {
      // The two decisions are independent, and this is the shape that proves
      // the flags are computed from `key` rather than from `definition`: a
      // definition belonging to another key withholds the characters, while the
      // rule — which reads the key and the real written value — still reports
      // what the write did. Withholding the analysis alongside the value would
      // reintroduce #5262 through the back door.
      await auditSettingsWrite({
        key: RPM_KEY,
        definition: PLAIN_DEF, // ATLAS_MODEL's entry — wrong key
        value: "0",
        action: "update",
        platformTier: true,
        ipAddress: null,
      });
      expect(meta().value).toBe(WITHHELD);
      expect(meta().maskReason).toBe("definition_mismatch");
      expect(meta().disablesControl).toBe(true);
    });
  });

  it("carries the action type, target and IP the forensic queries pivot on", async () => {
    await auditSettingsWrite({
      key: "ATLAS_MODEL",
      definition: PLAIN_DEF,
      value: "claude-opus-5",
      action: "update",
      platformTier: false,
      ipAddress: "203.0.113.7",
    });
    expect(lastAwaited()).toMatchObject({
      actionType: "settings.update",
      targetType: "settings",
      targetId: "ATLAS_MODEL",
      ipAddress: "203.0.113.7",
    });
    expect(meta().key).toBe("ATLAS_MODEL");
  });
});
