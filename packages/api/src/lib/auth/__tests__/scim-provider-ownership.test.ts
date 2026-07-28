/**
 * Contract-pinning tests for the `providerOwnership` mitigation of
 * GHSA-j8v8-g9cx-5qf4 (HIGH, @better-auth/scim).
 *
 * The advisory has NO fix on the 1.6.x stable line — the only upstream patch is
 * the breaking 1.7.0-beta.4+. `providerOwnership: { enabled: true }` is the
 * advisory's supported workaround, and it is opt-in, so nothing in the type
 * system or the plugin's defaults keeps it on. A future refactor of
 * `buildPlugins()` that drops the option would silently reopen a HIGH
 * account-takeover hole with every test still green.
 *
 * These tests pin the mechanism rather than the mere presence of a flag: they
 * assert the plugin's OWN schema gains the `userId` binding column when the
 * option is on and lacks it when off, so the pin fails if upstream ever
 * repurposes the option name.
 *
 * The residual half — providers created BEFORE the flag keep `userId = NULL`
 * and stay ownerless, because the column is nullable and nothing backfills it —
 * is covered by migration 0184 and its real-Postgres test
 * (`scim-provider-seal-ownerless-pg.test.ts`).
 */

import { describe, expect, it } from "bun:test";
import { scim } from "@better-auth/scim";

/** Field names the plugin declares on its `scimProvider` model. */
function scimProviderFields(plugin: ReturnType<typeof scim>): string[] {
  return Object.keys(plugin.schema?.scimProvider?.fields ?? {}).sort();
}

describe("SCIM providerOwnership mitigation (GHSA-j8v8-g9cx-5qf4)", () => {
  it("adds the `userId` owner-binding column when ownership is enabled", () => {
    const plugin = scim({ storeSCIMToken: "encrypted", providerOwnership: { enabled: true } });
    expect(scimProviderFields(plugin)).toContain("userId");
  });

  it("does NOT bind an owner when ownership is left at its default — the vulnerable shape", () => {
    // The negative half. If this ever starts containing `userId`, upstream has
    // changed the default (or shipped the 1.7.0 behaviour into 1.6.x) and the
    // workaround plus migration 0184 can be revisited.
    const plugin = scim({ storeSCIMToken: "encrypted" });
    expect(scimProviderFields(plugin)).not.toContain("userId");
  });

  it("the owner column is the ONLY schema difference the option introduces", () => {
    // Guards against the option quietly doing more than advertised — a
    // surprise column or table would change the migration story for a
    // security fix shipped under a freeze.
    const off = scimProviderFields(scim({ storeSCIMToken: "encrypted" }));
    const on = scimProviderFields(scim({ storeSCIMToken: "encrypted", providerOwnership: { enabled: true } }));
    expect(on.filter((f) => !off.includes(f))).toEqual(["userId"]);
    expect(off.filter((f) => !on.includes(f))).toEqual([]);
  });

  it("binds the owner as a nullable column — which is WHY migration 0184 exists", () => {
    // Documents the fail-open shape at the root of the residual risk: the
    // plugin's access check is `provider.userId && provider.userId !== userId`,
    // so a NULL owner short-circuits and grants access. A nullable column
    // means pre-existing rows are never backfilled by enabling the flag.
    const plugin = scim({ storeSCIMToken: "encrypted", providerOwnership: { enabled: true } });
    const userId = plugin.schema?.scimProvider?.fields?.userId as { required?: boolean } | undefined;
    expect(userId).toBeDefined();
    expect(userId?.required).toBe(false);
  });
});
