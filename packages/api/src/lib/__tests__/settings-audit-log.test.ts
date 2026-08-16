/**
 * #5180 — what the security-audit line actually EMITS.
 *
 * `settings.test.ts` pins the payload builder. This file pins the one line that
 * consumes it, and it exists because review measured that the builder's tests
 * cannot see that line at all: with 150 pure-function assertions green,
 * `log.warn({ ...line, value }, …)` — issue #5180 verbatim, plaintext straight
 * back into the log stream — passed the entire suite. So did dropping the
 * definition (masking every value, which silently destroys the "do not mask
 * everything" control), and so did deleting the audit emission outright.
 *
 * A SEPARATE FILE, deliberately. `settings.test.ts` avoids `mock.module` on
 * purpose — it injects the pool via `_resetPool(mockPool)` — and a module mock
 * applies to a whole file, so installing a logger mock there would put all 150
 * of its tests behind a fake logger. The isolated runner gives each file its
 * own module registry, which is what makes this split free.
 *
 * The assertions compare the EMITTED object against
 * `securitySensitiveAuditLine`'s own output rather than a hand-written literal.
 * That is the point: a literal on both sides would agree by construction with
 * whatever the emitter did, while equality-with-the-builder pins exactly the
 * property under test — the payload is passed through, with nothing added,
 * nothing dropped and nothing swapped.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

type LogCall = [Record<string, unknown>, string];

const warnCalls: LogCall[] = [];
const infoCalls: LogCall[] = [];

// ⚠️ ALL exports, per the repo's partial-mock rule: a `mock.module` factory
// REPLACES the module, so any export omitted here becomes undefined for every
// importer in this file — including `settings.ts`'s transitive dependencies.
// Awaited, not fire-and-forget, so the mock is installed before the dynamic
// imports below resolve. The FACTORY stays synchronous — an async factory
// deadlocks bun's module registry.
await mock.module("@atlas/api/lib/logger", () => {
  const stub = {
    warn: (obj: Record<string, unknown>, msg: string) => {
      warnCalls.push([obj, msg]);
    },
    info: (obj: Record<string, unknown>, msg: string) => {
      infoCalls.push([obj, msg]);
    },
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
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
    hashShareToken: (token: string) => token,
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
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
  });

  afterEach(() => {
    _resetPool(null);
    _resetSettingsCache();
    if (origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDatabaseUrl;
  });

  /** The single security-audit line, or a failure if there is not exactly one. */
  function auditLine(): Record<string, unknown> {
    const lines = warnCalls.filter(([obj]) => obj.event === "security_setting.changed");
    expect(lines).toHaveLength(1);
    return lines[0]![0];
  }

  // ⚠️ THE ONE ASSERTION THAT SEES THE LEAK. `log.warn({ ...line, value }, …)`
  // is a one-keystroke edit at the call site and reintroduces #5180; nothing in
  // `settings.test.ts` goes red for it, because the builder it tests is still
  // returning the right thing. Equality with the builder's output is what
  // catches it: an extra `value` field makes the emitted object unequal.
  it("emits exactly the builder's payload — nothing added, dropped or swapped", async () => {
    await setSetting(RPM, "0", "user_1");
    expect(auditLine()).toEqual(
      securitySensitiveAuditLine({
        key: RPM,
        definition: getSettingDefinition(RPM),
        action: "set",
        value: "0",
        actorId: "user_1",
        orgId: undefined,
      }) as unknown as Record<string, unknown>,
    );
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
      securitySensitiveAuditLine({
        key: RPM,
        definition: getSettingDefinition(RPM),
        action: "clear",
        value: undefined,
        actorId: "user_2",
        orgId: undefined,
      }) as unknown as Record<string, unknown>,
    );
  });

  // Deleting the emission entirely was the third survivor. These two are what
  // make its absence visible in each direction: a sensitive key must produce a
  // line, a non-sensitive one must not.
  it("emits NO security-audit line for a non-sensitive key", async () => {
    await setSetting(PLAIN, "500", "user_1");
    expect(warnCalls.filter(([obj]) => obj.event === "security_setting.changed")).toHaveLength(0);
    // The generic settings-change info log still fires, so this is a statement
    // about the AUDIT line specifically, not about the write being skipped.
    expect(infoCalls.some(([obj]) => obj.key === PLAIN)).toBe(true);
  });

  it("carries the actor through, so the line can answer WHO", async () => {
    await setSetting(RPM, "0", "operator_9");
    expect(auditLine().actorId).toBe("operator_9");
  });
});
