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
 *     being dropped with a `log.warn` the operator may have silenced
 *
 * ⚠️ CLAIM 1 NEEDS A REGISTRY KEY THAT IS ACTUALLY `secret: true`, and it
 * needs redacted and raw to DIFFER on it. This is the trap #5180 documented:
 * for a key whose value is not secret, the redacted and raw strings are
 * identical, so an assertion comparing them passes under a fix and under its
 * removal alike. Every claim-1 test below therefore drives a real
 * `secret: true` definition (`RESEND_API_KEY`) with a value that is visibly
 * not the placeholder.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";

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

const { auditSettingsWrite } = await import("@atlas/api/lib/audit/settings-write");
const { getSettingDefinition } = await import("@atlas/api/lib/settings");

/** A real `secret: true`, `scope: "platform"` registry entry. */
const SECRET_DEF = getSettingDefinition("RESEND_API_KEY");
/** A real non-secret entry, so the verbatim arm is exercised against the registry too. */
const PLAIN_DEF = getSettingDefinition("ATLAS_MODEL");

const SECRET_VALUE = "re_live_51H8xQ2eZvKYlo2C_not_a_placeholder";
const WITHHELD = "[withheld:secret-setting]";

const lastAwaited = (): AwaitedEntry => awaited[awaited.length - 1]!;
const meta = (): Record<string, unknown> => lastAwaited().metadata ?? {};

describe("auditSettingsWrite", () => {
  beforeEach(() => {
    awaited.length = 0;
    fireAndForget.length = 0;
    awaitRejectsWith = undefined;
  });

  it("the fixture is sound — the registry entries this file relies on are what it claims", () => {
    // Without this the whole suite could be asserting against `undefined`
    // definitions, which land in `redactAuditValue`'s fail-closed arm and
    // would make claim 1 pass for the wrong reason.
    expect(SECRET_DEF?.secret).toBe(true);
    expect(SECRET_DEF?.scope).toBe("platform");
    expect(PLAIN_DEF?.secret).toBeFalsy();
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
    });

    it("⭐ propagates a rejection instead of swallowing it", async () => {
      // The whole point of the await: when the row cannot be committed the
      // caller has to find out. `logAdminAction` would have dropped this with
      // a `log.warn` — which a raised ATLAS_LOG_LEVEL then eats.
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
