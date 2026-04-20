import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Crown, Shield, ShieldCheck } from "lucide-react";
import { _resetWarnSets, roleBadge } from "../roles";

describe("roleBadge", () => {
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    _resetWarnSets();
  });

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test("owner resolves to Crown + purple classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className } = roleBadge("owner");
    expect(Icon).toBe(Crown);
    expect(className).toContain("text-purple-700");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("admin resolves to ShieldCheck + red classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className } = roleBadge("admin");
    expect(Icon).toBe(ShieldCheck);
    expect(className).toContain("text-red-700");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("member resolves to Shield + primary classes", () => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { Icon, className } = roleBadge("member");
    expect(Icon).toBe(Shield);
    expect(className).toContain("text-primary");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("unknown roles fall back to the neutral member variant and warn once", () => {
    // Fail-safe rendering: if the server returns a role the UI doesn't know
    // about (legacy "guest", future "billing-admin", DB drift, an enterprise
    // role leaking into the community enum), the sheet must still render a
    // readable badge instead of an empty className. The member variant is
    // the safe default — it's the lowest-privilege role and matches what an
    // operator would expect for "unknown."
    //
    // The `console.warn` is the drift-detection signal for operators / Sentry
    // breadcrumbs. One warn per unique unknown role per session avoids
    // spamming the console when a workspace has many members with the same
    // drifted role.
    //
    // Note: this is the *opposite* safety posture from
    // `app/admin/users/roles.ts`'s `isDemotion`, which is fail-*closed*
    // (unknown → always confirm). Display fails safe; permission-change
    // gates fail closed.
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const unknown = roleBadge("fail-safe-rendering-test-role");
    expect(unknown.Icon).toBe(Shield);
    expect(unknown.className).toContain("text-primary");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("fail-safe-rendering-test-role");

    // Same unknown role a second time — dedup should suppress the warn.
    roleBadge("fail-safe-rendering-test-role");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A different unknown role warns exactly once more.
    roleBadge("another-unknown-role");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
