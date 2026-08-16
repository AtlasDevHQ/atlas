/**
 * #5180 — what the security-audit line actually EMITS.
 *
 * `settings.test.ts` pins the payload builder. This file pins the one line that
 * consumes it, and it exists because review measured that the builder's tests
 * cannot see that line at all: with 150 pure-function assertions green,
 * `log.warn({ ...line, value }, …)` — issue #5180 verbatim, plaintext straight
 * back into the log stream — passed the entire suite. So did dropping the
 * definition (withholding every value, which silently destroys the "do not
 * withhold everything" control), and so did deleting the audit outright.
 *
 * A SEPARATE FILE, deliberately. `settings.test.ts` avoids `mock.module` on
 * purpose — it injects the pool via `_resetPool(mockPool)` — and a module mock
 * applies to a whole file, so installing a logger mock there would put all 150
 * of its tests behind a fake logger. The isolated runner gives each file its
 * own module registry, which is what makes this split free.
 *
 * Most assertions compare the EMITTED object against
 * `securitySensitiveAuditLine`'s own output rather than a hand-written literal.
 * That is the point: a literal on both sides would restate the payload and pass
 * whether or not the emitter used the builder at all, while
 * equality-with-the-builder pins exactly the property under test — the payload
 * is passed through, with nothing added, dropped or swapped.
 *
 * ⚠️ That comparison has one blind spot, and the last block in this file exists
 * for it: both sides are built from the same inputs, so an edit that changes
 * what the emitter FEEDS the builder is invisible whenever the hand-written
 * input coincides with the mutated one. `undefined` is the value every
 * dropped-argument mutation produces, which is why `orgId` is driven with a
 * real workspace here rather than left to default.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
// Type-only, so it does not pull the module in ahead of the logger mock below.
import type { SecuritySensitiveAuditInput } from "@atlas/api/lib/settings";

/**
 * `[first-arg, message]`. The first argument is `unknown`, not an object:
 * `settings.ts` also calls `log.warn("isSaasModeForGuard: …")` with a bare
 * string, so typing it as a record would be a claim the stub cannot keep.
 */
type LogCall = [unknown, string | undefined];

const warnCalls: LogCall[] = [];
const infoCalls: LogCall[] = [];
/**
 * Recorded, not discarded. A stub that no-ops `error`/`fatal` cannot assert
 * "and nothing went wrong" — so the natural future edit
 * `try { emit(line) } catch (err) { log.error(…) }`, an audit swallowed by a
 * catch that logs, would leave every test here green.
 */
const errorCalls: LogCall[] = [];

// ⚠️ ALL exports, per the repo's partial-mock rule: a `mock.module` factory
// REPLACES the module, so any export omitted here becomes undefined for every
// importer in this file — including `settings.ts`'s transitive dependencies.
// Awaited, not fire-and-forget, so the mock is installed before the dynamic
// imports below resolve. The FACTORY stays synchronous — an async factory
// deadlocks bun's module registry.
await mock.module("@atlas/api/lib/logger", () => {
  const stub = {
    warn: (obj: unknown, msg?: string) => {
      warnCalls.push([obj, msg]);
    },
    info: (obj: unknown, msg?: string) => {
      infoCalls.push([obj, msg]);
    },
    error: (obj: unknown, msg?: string) => {
      errorCalls.push([obj, msg]);
    },
    fatal: (obj: unknown, msg?: string) => {
      errorCalls.push([obj, msg]);
    },
    debug: () => {},
    trace: () => {},
    child: () => stub,
    level: "info",
  };
  return {
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
    withRequestContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
    getRequestContext: () => undefined,
    redactPaths: [] as string[],
    scrubErrSerializer: (value: unknown) => value,
    scrubLogFormatter: (obj: unknown) => obj,
    getLogger: () => stub,
    createLogger: () => stub,
    // Visibly NOT the token: returning the input would invert a security
    // helper inside a test file about not disclosing secrets, and would let a
    // caller that forgot to hash look correct here.
    hashShareToken: (token: string) => `stub-hash-of-${token.length}-chars`,
    setLogLevel: () => true,
  };
});

const { _resetPool } = await import("@atlas/api/lib/db/internal");
const {
  setSetting,
  deleteSetting,
  securitySensitiveAuditLine,
  getSettingDefinition,
  _resetSettingsCache,
} = await import("@atlas/api/lib/settings");
type InternalPool = Parameters<typeof _resetPool>[0];

const mockPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
} as unknown as NonNullable<InternalPool>;

/** A sensitive key with no `secret` flag — the verbatim control. */
const RPM = "ATLAS_TRIAL_IP_RATE_LIMIT_RPM";
/** Sensitive, and its value must never be logged verbatim once it is secret. */
const SOURCES = "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES";
/** Not sensitive — must produce no audit line at all. */
const PLAIN = "ATLAS_ROW_LIMIT";

const origDatabaseUrl = process.env.DATABASE_URL;

describe("auditSecuritySensitiveChange — what reaches the log stream (#5180)", () => {
  beforeEach(() => {
    warnCalls.length = 0;
    infoCalls.length = 0;
    errorCalls.length = 0;
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
  });

  afterEach(() => {
    // Nothing in this file should provoke an error-level line. If one appears,
    // the most likely cause is an audit swallowed by a catch that logs.
    expect(errorCalls).toEqual([]);
    _resetPool(null);
    _resetSettingsCache();
    if (origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDatabaseUrl;
  });

  /** The one security-audit call, as `[payload, message]`. */
  function auditCall(): [Record<string, unknown>, string | undefined] {
    const lines = warnCalls.filter(
      (call): call is [Record<string, unknown>, string | undefined] =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>).event === "security_setting.changed",
    );
    const [first] = lines;
    // Thrown rather than asserted so the failure names the real problem, and so
    // no `!` is needed below — `toHaveLength` would satisfy a reader but not
    // the compiler.
    if (lines.length !== 1 || first === undefined) {
      throw new Error(`expected exactly one security-audit line, got ${lines.length}`);
    }
    return first;
  }

  /** The single security-audit payload. */
  function auditLine(): Record<string, unknown> {
    return auditCall()[0];
  }

  /**
   * The payload the builder produces for these inputs, as a plain record so it
   * compares against the emitted one without a cast. Throws on `null`, which
   * would mean the key stopped being sensitive — a different bug, and one the
   * caller should not discover as a confusing equality failure.
   */
  function builtLine(input: SecuritySensitiveAuditInput): Record<string, unknown> {
    const line = securitySensitiveAuditLine(input);
    if (!line) throw new Error(`builder returned null for sensitive key ${input.key}`);
    return { ...line };
  }

  // ⚠️ THIS ASSERTION DOES NOT SEE THE PLAINTEXT LEAK — see the
  // `secret: true` block below, which does. `value` is a DECLARED field of the
  // payload, so `log.warn({ ...line, value }, …)` overwrites it rather than
  // adding a key, and while every shipped sensitive key is non-secret the raw
  // and redacted values are equal, so both sides of this comparison move
  // together.
  //
  // What this assertion does close is everything that changes WHAT is emitted:
  // a dropped or swapped field, a wrong actor or org, a definition that is not
  // the key's own. Equality against the builder's own output rather than a
  // literal is deliberate — a literal here would restate the payload and pass
  // whether or not the emitter used the builder at all.
  it("emits exactly the builder's payload — nothing dropped or swapped", async () => {
    await setSetting(RPM, "0", "user_1");
    expect(auditLine()).toEqual(
      builtLine({
        key: RPM,
        definition: getSettingDefinition(RPM),
        action: "set",
        value: "0",
        actorId: "user_1",
        orgId: undefined,
      }),
    );
  });

  it("records the message, and the message does not carry the value", async () => {
    // A template literal is a leak channel no type can close: `${line.value}`
    // and `${rawValue}` are both just strings there. Nothing else in this file
    // looks at the message at all, so without this the emitter could append
    // the secret to the text and stay green.
    await setSetting(SOURCES, "warehouse_key,extractor", "user_1");
    const [, msg] = auditCall();
    expect(msg).toBe(`Security-sensitive setting changed at runtime: ${SOURCES}`);
    expect(msg).not.toContain("warehouse_key,extractor");
  });

  it("passes the key's OWN definition, so a non-secret value stays verbatim", async () => {
    // The sibling mutation: `definition: undefined` at the call site fails
    // closed and withholds EVERY value, which looks correct — `valueMasked` is
    // true and the value is a placeholder — while quietly destroying the
    // control that the issue's second acceptance criterion exists to protect.
    // Only an assertion downstream of the real call site can tell.
    await setSetting(SOURCES, "warehouse_key,extractor", "user_1");
    const line = auditLine();
    expect(line.value).toBe("warehouse_key,extractor");
    expect(line.valueMasked).toBe(false);
    expect(line.maskReason).toBeUndefined();
    // The flags still travel: a widened source list is the event itself.
    expect(line.widensAuthority).toBe(true);
  });

  it("audits a CLEAR through deleteSetting", async () => {
    await deleteSetting(RPM, "user_2");
    expect(auditLine()).toEqual(
      builtLine({
        key: RPM,
        definition: getSettingDefinition(RPM),
        action: "clear",
        value: undefined,
        actorId: "user_2",
        orgId: undefined,
      }),
    );
  });

  // ⚠️ `orgId` was `undefined` on both sides of every assertion above, which is
  // the value a dropped-argument mutation produces — so the emitter could have
  // stopped passing it and nothing would have moved. Two of the four sensitive
  // keys are workspace-scoped, so this is the field that answers "whose control
  // moved", on exactly the keys where that is the question.
  it("records the org for a workspace-scoped key", async () => {
    await setSetting(SOURCES, "warehouse_key", "user_1", "org_9");
    expect(auditLine().orgId).toBe("org_9");
  });

  it("records NO org for a platform-scoped key, even when one was passed", async () => {
    // `setSetting` collapses `orgId` to undefined for a platform-scoped key,
    // because the write is global. Logging the caller's `orgId` instead would
    // claim a blast radius of one workspace for a change that hit every
    // workspace — a misattribution in the line that exists for the incident.
    await setSetting(RPM, "0", "user_1", "org_9");
    expect(auditLine().orgId).toBeUndefined();
  });

  // Deleting the emission entirely was the third survivor. These two are what
  // make its absence visible in each direction: a sensitive key must produce a
  // line, a non-sensitive one must not.
  it("emits NO security-audit line for a non-sensitive key", async () => {
    await setSetting(PLAIN, "500", "user_1");
    expect(
      warnCalls.filter(
        ([obj]) =>
          typeof obj === "object" &&
          obj !== null &&
          (obj as Record<string, unknown>).event === "security_setting.changed",
      ),
    ).toHaveLength(0);
    // The generic settings-change info log still fires, so this is a statement
    // about the AUDIT line specifically, not about the write being skipped.
    expect(
      infoCalls.some(
        ([obj]) =>
          typeof obj === "object" &&
          obj !== null &&
          (obj as Record<string, unknown>).key === PLAIN,
      ),
    ).toBe(true);
  });

  it("carries the actor through, so the line can answer WHO", async () => {
    await setSetting(RPM, "0", "operator_9");
    expect(auditLine().actorId).toBe("operator_9");
  });

  // ⚠️ THE BLOCK THAT SEES THE PLAINTEXT LEAK, and the reason the rest of this
  // file cannot.
  //
  // Everything above compares two payloads that move together, because no
  // shipped sensitive key is `secret: true` — so redacted equals raw on every
  // input the emitter can reach, and the leak edit is a no-op. Two drafts of
  // this file concluded from that "no assertion can catch it" and reached for a
  // type instead. That conclusion was wrong, and the error is worth naming: it
  // treated a fact about the REGISTRY's current contents as a fact about what
  // is observable.
  //
  // `getSettingDefinition` returns the object `SETTINGS_MAP` holds. Flipping
  // `secret` on it for the duration of one test makes redacted and raw differ
  // on a fully reachable input, and the leak becomes an ordinary assertion —
  // which also catches the two edits the brand cannot see: inlining `log.warn`
  // back into the caller, and fabricating a `{ key, secret: false }` definition
  // at the call site.
  //
  // Scoped and restored. Never at top level, and the isolated runner gives this
  // file its own module registry, so the flip cannot reach another file.
  describe("a sensitive key that IS secret — #5180's actual subject", () => {
    const SECRET_WRITTEN = "sk-ant-api03-SUPERSECRET-payload";
    let restore: (() => void) | undefined;

    beforeEach(() => {
      const def = getSettingDefinition(RPM) as { secret?: boolean } | undefined;
      if (!def) throw new Error(`no registry definition for ${RPM}`);
      const prev = def.secret;
      def.secret = true;
      restore = () => {
        if (prev === undefined) delete def.secret;
        else def.secret = prev;
      };
    });

    afterEach(() => {
      restore?.();
      restore = undefined;
      // The flip must not outlive the test, or every assertion in the blocks
      // above silently changes meaning.
      expect(getSettingDefinition(RPM)?.secret).not.toBe(true);
    });

    it("withholds the plaintext from the log stream, not merely from the builder", async () => {
      await setSetting(RPM, SECRET_WRITTEN, "user_1");
      const [line, msg] = auditCall();
      expect(line.value).toBe("[withheld:secret-setting]");
      expect(line.valueMasked).toBe(true);
      expect(line.maskReason).toBe("secret");
      // The WHOLE record, payload and message: a secret that lands in a sibling
      // field or gets appended to the text is the same breach.
      expect(JSON.stringify(line)).not.toContain("SUPERSECRET");
      expect(msg).not.toContain("SUPERSECRET");
    });

    it("still classifies from the written value while withholding it", async () => {
      // `"0"` is the fixture that can tell the two apart: withheld it is
      // unparseable, raw it is the documented disabled sentinel. A redact-early
      // emitter would report the abuse control as still on.
      await setSetting(RPM, "0", "user_1");
      const line = auditLine();
      expect(line.disablesControl).toBe(true);
      expect(line.value).toBe("[withheld:secret-setting]");
    });
  });
});
