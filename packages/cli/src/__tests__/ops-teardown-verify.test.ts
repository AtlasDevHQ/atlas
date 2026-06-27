/**
 * Tests for `atlas ops teardown-verify-accounts` (#3974). The command tears
 * down throwaway `/verify-prod-signup` accounts from a region's internal DB, so
 * the surface that matters is:
 *   1. The execute double-gate (ATLAS_TEARDOWN_OK=1 + --confirm) — missing
 *      either falls back to DRY RUN, never an accidental delete.
 *   2. Region-DB resolution refuses to run without an explicit region/url (no
 *      DATABASE_URL fallback — the wrong-DB footgun).
 *   3. The throwaway-email guard blocks a non-plus-addressed address on execute.
 *   4. Target resolution maps email → user → owned orgs against a fake query.
 *   5. The orchestration: dry-run lists, execute calls purge→softDelete→
 *      hardDelete in order, skips non-owners, surfaces Stripe warnings, and
 *      keeps going after one org errors.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  TEARDOWN_OK_ENV,
  MAX_TEARDOWN_TARGETS,
  REGION_DB_ENV,
  checkTeardownGate,
  isDryRun,
  checkBlastRadius,
  resolveRegionDbUrl,
  parseTargetEmails,
  isThrowawayVerifyEmail,
  assertTargetsAllowed,
  resolveVerifyTargets,
  countOwnedOrgs,
  teardownTargets,
  handleTeardownVerifyAccounts,
  type RowQuery,
  type TeardownDeps,
  type VerifyTarget,
} from "../commands/ops-teardown-verify";
import { handleOps } from "../commands/ops";
import type { StripeTeardownOutcome } from "@atlas/api/lib/billing/workspace-teardown";

// --- checkTeardownGate (mirrors checkWipeGate's double-gate contract) ---

describe("checkTeardownGate", () => {
  it("returns a reason when ATLAS_TEARDOWN_OK is missing", () => {
    expect(checkTeardownGate(["--confirm"], {} as NodeJS.ProcessEnv)).toContain(TEARDOWN_OK_ENV);
  });

  it("returns a reason when --confirm is missing", () => {
    expect(
      checkTeardownGate([], { [TEARDOWN_OK_ENV]: "1" } as NodeJS.ProcessEnv),
    ).toContain("--confirm");
  });

  it("rejects a truthy-but-not-1 value (e.g. ATLAS_TEARDOWN_OK=true)", () => {
    expect(
      checkTeardownGate(["--confirm"], { [TEARDOWN_OK_ENV]: "true" } as NodeJS.ProcessEnv),
    ).toContain(TEARDOWN_OK_ENV);
  });

  it("returns null (cleared to execute) when both gates are present", () => {
    expect(
      checkTeardownGate(["--confirm"], { [TEARDOWN_OK_ENV]: "1" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

// --- resolveRegionDbUrl ---

describe("resolveRegionDbUrl", () => {
  it("returns --database-url when set (region null), regardless of --region", () => {
    const r = resolveRegionDbUrl(
      ["--database-url", "postgresql://x/y", "--region", "eu"],
      { ATLAS_REGION_EU_DB_URL: "postgresql://eu" } as NodeJS.ProcessEnv,
    );
    expect(r).toEqual({ ok: true, url: "postgresql://x/y", source: "--database-url", region: null });
  });

  it("maps --region us|eu|apac to the matching ATLAS_REGION_*_DB_URL with the region key", () => {
    const env = {
      ATLAS_REGION_US_DB_URL: "postgresql://us",
      ATLAS_REGION_EU_DB_URL: "postgresql://eu",
      ATLAS_REGION_APAC_DB_URL: "postgresql://apac",
    } as NodeJS.ProcessEnv;
    expect(resolveRegionDbUrl(["--region", "us"], env)).toMatchObject({ ok: true, url: "postgresql://us", region: "us" });
    expect(resolveRegionDbUrl(["--region", "eu"], env)).toMatchObject({ ok: true, url: "postgresql://eu", region: "eu" });
    expect(resolveRegionDbUrl(["--region", "apac"], env)).toMatchObject({ ok: true, url: "postgresql://apac", region: "apac" });
  });

  it("errors on an unknown region", () => {
    const r = resolveRegionDbUrl(["--region", "moon"], {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--region must be one of");
  });

  it("rejects a prototype-chain key (constructor) — own-key check, not `in`", () => {
    const r = resolveRegionDbUrl(["--region", "constructor"], {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--region must be one of");
  });

  it("errors when the region's env var is unset", () => {
    const r = resolveRegionDbUrl(["--region", "eu"], {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(REGION_DB_ENV.eu);
  });

  it("errors with no DATABASE_URL fallback when neither flag is given", () => {
    const r = resolveRegionDbUrl([], { DATABASE_URL: "postgresql://wrong" } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no DATABASE_URL fallback");
  });
});

// --- isDryRun / checkBlastRadius (the two execute safety gates) ---

describe("isDryRun", () => {
  const exec = { [TEARDOWN_OK_ENV]: "1" } as NodeJS.ProcessEnv;
  it("is true when the gate is not satisfied (preview by default)", () => {
    expect(isDryRun(["--confirm"], {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isDryRun([], exec)).toBe(true);
  });
  it("is false only when both gate halves are present", () => {
    expect(isDryRun(["--confirm"], exec)).toBe(false);
  });
  it("--dry-run forces preview even when the gate is fully open", () => {
    expect(isDryRun(["--confirm", "--dry-run"], exec)).toBe(true);
  });
});

describe("checkBlastRadius", () => {
  it("allows any count on dry-run (preview uncapped)", () => {
    expect(checkBlastRadius(MAX_TEARDOWN_TARGETS + 50, true)).toBeNull();
  });
  it("allows up to the cap on execute (boundary)", () => {
    expect(checkBlastRadius(MAX_TEARDOWN_TARGETS, false)).toBeNull();
  });
  it("refuses above the cap on execute (boundary + 1)", () => {
    const r = checkBlastRadius(MAX_TEARDOWN_TARGETS + 1, false);
    expect(r).toContain("Refusing to execute");
    expect(r).toContain(String(MAX_TEARDOWN_TARGETS));
  });
});

// --- parseTargetEmails ---

describe("parseTargetEmails", () => {
  it("parses a single --email", () => {
    expect(parseTargetEmails(["--email", "matt+us@useatlas.dev"])).toEqual([
      "matt+us@useatlas.dev",
    ]);
  });

  it("splits comma-separated and merges repeated --email flags, deduped + lowercased", () => {
    expect(
      parseTargetEmails([
        "--email",
        "matt+us@useatlas.dev,Matt+EU@useatlas.dev",
        "--email",
        "matt+apac@useatlas.dev",
        "--email",
        "matt+us@useatlas.dev",
      ]),
    ).toEqual(["matt+us@useatlas.dev", "matt+eu@useatlas.dev", "matt+apac@useatlas.dev"]);
  });

  it("throws when no --email is given (never an implicit delete-all)", () => {
    expect(() => parseTargetEmails(["--region", "us"])).toThrow(/At least one --email/);
  });

  it("throws when --email has no value", () => {
    expect(() => parseTargetEmails(["--email"])).toThrow(/requires a value/);
    expect(() => parseTargetEmails(["--email", "--confirm"])).toThrow(/requires a value/);
  });

  it("trims whitespace and drops empty parts (trailing comma, spaces)", () => {
    expect(parseTargetEmails(["--email", "a@x.com, ,b@x.com,"])).toEqual(["a@x.com", "b@x.com"]);
  });
});

// --- isThrowawayVerifyEmail / assertTargetsAllowed ---

describe("isThrowawayVerifyEmail", () => {
  it("accepts plus-addressed business emails", () => {
    expect(isThrowawayVerifyEmail("matt+us@useatlas.dev")).toBe(true);
  });

  it("rejects a plain address and a malformed one", () => {
    expect(isThrowawayVerifyEmail("ceo@bigcustomer.com")).toBe(false);
    expect(isThrowawayVerifyEmail("not-an-email")).toBe(false);
    expect(isThrowawayVerifyEmail("+leadingplus@x.com")).toBe(true);
  });

  it("only the local part counts — a `+` in the domain is not a throwaway signal", () => {
    expect(isThrowawayVerifyEmail("matt@x+.com")).toBe(false);
  });

  it("rejects an address with an empty local part (at index 0)", () => {
    expect(isThrowawayVerifyEmail("@x.com")).toBe(false);
  });
});

describe("assertTargetsAllowed", () => {
  it("passes when every email is plus-addressed", () => {
    expect(() =>
      assertTargetsAllowed(["matt+us@useatlas.dev", "matt+eu@useatlas.dev"], false),
    ).not.toThrow();
  });

  it("throws listing the non-throwaway addresses when not forced", () => {
    expect(() =>
      assertTargetsAllowed(["matt+us@useatlas.dev", "ceo@bigcustomer.com"], false),
    ).toThrow(/ceo@bigcustomer.com/);
  });

  it("passes any address when --force is set", () => {
    expect(() => assertTargetsAllowed(["ceo@bigcustomer.com"], true)).not.toThrow();
  });
});

// --- resolveVerifyTargets (against a fake RowQuery) ---

interface FakeRow extends Record<string, unknown> {
  userId: string;
  email: string;
  userName: string | null;
  userStripeCustomerId: string | null;
  memberRole: string | null;
  orgId: string | null;
  orgName: string | null;
  orgSlug: string | null;
  region: string | null;
  workspaceStatus: string | null;
  stripeCustomerId: string | null;
}

/** Build a fake query that returns the given rows per lower-cased email param. */
function fakeQuery(byEmail: Record<string, FakeRow[]>): RowQuery {
  return (async <T extends Record<string, unknown>>(_sql: string, params?: unknown[]) => {
    const email = String(params?.[0] ?? "");
    return (byEmail[email] ?? []) as unknown as T[];
  }) as RowQuery;
}

function row(over: Partial<FakeRow>): FakeRow {
  return {
    userId: "user_1",
    email: "matt+us@useatlas.dev",
    userName: "Matt US",
    userStripeCustomerId: null,
    memberRole: "owner",
    orgId: "org_1",
    orgName: "Atlas us Verify",
    orgSlug: "atlas-us-verify",
    region: "us",
    workspaceStatus: "active",
    stripeCustomerId: null,
    ...over,
  };
}

describe("resolveVerifyTargets", () => {
  it("resolves a found user with one owned org", async () => {
    const q = fakeQuery({ "matt+us@useatlas.dev": [row({})] });
    const [t] = await resolveVerifyTargets(q, ["matt+us@useatlas.dev"]);
    expect(t).toMatchObject({ email: "matt+us@useatlas.dev", userId: "user_1", found: true });
    expect(t!.orgs).toHaveLength(1);
    expect(t!.orgs[0]).toMatchObject({ orgId: "org_1", region: "us", isOwner: true });
  });

  it("marks an email with no user row as not found", async () => {
    const q = fakeQuery({});
    const [t] = await resolveVerifyTargets(q, ["ghost+us@useatlas.dev"]);
    expect(t).toEqual({
      email: "ghost+us@useatlas.dev",
      userId: null,
      found: false,
      userStripeCustomerId: null,
      orgs: [],
    });
  });

  it("carries user.stripeCustomerId onto the target (the #4011 user-level customer)", async () => {
    const q = fakeQuery({
      "matt+us@useatlas.dev": [row({ userStripeCustomerId: "cus_user", stripeCustomerId: null })],
    });
    const [t] = await resolveVerifyTargets(q, ["matt+us@useatlas.dev"]);
    expect(t!.userStripeCustomerId).toBe("cus_user");
    // The org column is null in the #4011 shape — the customer lives only on the user.
    expect(t!.orgs[0]!.stripeCustomerId).toBeNull();
  });

  it("treats a user with no membership (LEFT JOIN null org) as found with zero orgs", async () => {
    const q = fakeQuery({
      "matt+us@useatlas.dev": [
        row({ memberRole: null, orgId: null, orgName: null, orgSlug: null, region: null, workspaceStatus: null }),
      ],
    });
    const [t] = await resolveVerifyTargets(q, ["matt+us@useatlas.dev"]);
    expect(t).toMatchObject({ found: true, userId: "user_1" });
    expect(t!.orgs).toEqual([]);
  });

  it("records owner vs non-owner across multiple memberships", async () => {
    const q = fakeQuery({
      "matt+us@useatlas.dev": [
        row({ orgId: "org_owned", memberRole: "owner" }),
        row({ orgId: "org_shared", memberRole: "member", stripeCustomerId: "cus_x" }),
      ],
    });
    const [t] = await resolveVerifyTargets(q, ["matt+us@useatlas.dev"]);
    expect(t!.orgs.map((o) => [o.orgId, o.isOwner])).toEqual([
      ["org_owned", true],
      ["org_shared", false],
    ]);
  });

  it("resolves each email independently across a multi-email list", async () => {
    const q = fakeQuery({
      "matt+us@useatlas.dev": [row({ userId: "u_us", orgId: "org_us", region: "us" })],
      "matt+eu@useatlas.dev": [row({ userId: "u_eu", orgId: "org_eu", region: "eu" })],
    });
    const targets = await resolveVerifyTargets(q, [
      "matt+us@useatlas.dev",
      "matt+eu@useatlas.dev",
      "ghost+apac@useatlas.dev",
    ]);
    expect(targets).toHaveLength(3);
    expect(targets[0]).toMatchObject({ email: "matt+us@useatlas.dev", found: true });
    expect(targets[0]!.orgs[0]!.orgId).toBe("org_us");
    expect(targets[1]).toMatchObject({ email: "matt+eu@useatlas.dev", found: true });
    expect(targets[1]!.orgs[0]!.orgId).toBe("org_eu");
    expect(targets[2]).toMatchObject({ email: "ghost+apac@useatlas.dev", found: false, orgs: [] });
  });
});

// --- countOwnedOrgs (blast-radius the execute guard caps) ---

describe("countOwnedOrgs", () => {
  it("counts only owned orgs across targets, ignoring non-owner memberships", () => {
    const targets: VerifyTarget[] = [
      { email: "a", userId: "u1", found: true, userStripeCustomerId: null, orgs: [
        { orgId: "o1", orgName: null, orgSlug: null, region: "us", workspaceStatus: "active", stripeCustomerId: null, isOwner: true },
        { orgId: "o2", orgName: null, orgSlug: null, region: "us", workspaceStatus: "active", stripeCustomerId: null, isOwner: false },
      ] },
      { email: "b", userId: "u2", found: true, userStripeCustomerId: null, orgs: [
        { orgId: "o3", orgName: null, orgSlug: null, region: "eu", workspaceStatus: "active", stripeCustomerId: null, isOwner: true },
      ] },
      { email: "c", userId: null, found: false, userStripeCustomerId: null, orgs: [] },
    ];
    expect(countOwnedOrgs(targets)).toBe(2);
    expect(countOwnedOrgs(targets)).toBeLessThanOrEqual(MAX_TEARDOWN_TARGETS);
  });

  it("is 0 when nothing resolved", () => {
    expect(countOwnedOrgs([])).toBe(0);
  });
});

// --- teardownTargets (orchestration, with injected fakes) ---

function okStripe(over: Partial<StripeTeardownOutcome> = {}): StripeTeardownOutcome {
  return { attempted: true, actions: [], warnings: [], ...over };
}

function target(over: Partial<VerifyTarget> & { orgs?: VerifyTarget["orgs"] }): VerifyTarget {
  return {
    email: "matt+us@useatlas.dev",
    userId: "user_1",
    found: true,
    userStripeCustomerId: null,
    orgs: [],
    ...over,
  };
}

function ownedOrg(over: Partial<VerifyTarget["orgs"][number]> = {}): VerifyTarget["orgs"][number] {
  return {
    orgId: "org_1",
    orgName: "Atlas us Verify",
    orgSlug: "atlas-us-verify",
    region: "us",
    workspaceStatus: "active",
    stripeCustomerId: null,
    isOwner: true,
    ...over,
  };
}

describe("teardownTargets", () => {
  it("dry-run lists owned orgs as would-tear-down and calls no deps", async () => {
    const calls: string[] = [];
    const deps: TeardownDeps = {
      purgeStripe: async () => { calls.push("purge"); return okStripe(); },
      softDelete: async () => { calls.push("soft"); return true; },
      hardDelete: async () => { calls.push("hard"); return 0; },
    };
    const report = await teardownTargets(
      [target({ userStripeCustomerId: "cus_user", orgs: [ownedOrg()] })],
      deps,
      true,
    );
    expect(calls).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.targets[0]!.orgs[0]!.status).toBe("would-tear-down");
    // Preview must still report the user-level customer that the live run will
    // delete — a dropped carry-through here would make the dry run lie (#4011).
    expect(report.targets[0]!.userStripeCustomerId).toBe("cus_user");
    expect(report.totals).toMatchObject({ orgsWouldTearDown: 1, orgsTornDown: 0 });
  });

  it("execute calls purge → softDelete → hardDelete in order and sums rows", async () => {
    const order: string[] = [];
    const deps: TeardownDeps = {
      purgeStripe: async () => { order.push("purge"); return okStripe({ actions: ["deleted Stripe customer cus_1"] }); },
      softDelete: async () => { order.push("soft"); return true; },
      hardDelete: async () => { order.push("hard"); return 42; },
    };
    const report = await teardownTargets(
      [target({ orgs: [ownedOrg({ stripeCustomerId: "cus_1" })] })],
      deps,
      false,
    );
    expect(order).toEqual(["purge", "soft", "hard"]);
    const org = report.targets[0]!.orgs[0]!;
    expect(org.status).toBe("torn-down");
    expect(org.rowsPurged).toBe(42);
    expect(org.stripeActions).toContain("deleted Stripe customer cus_1");
    expect(report.totals).toMatchObject({ orgsTornDown: 1, rowsPurged: 42, errors: 0 });
  });

  it("unions the user-level customer into the purge call (#4011 — org column null)", async () => {
    // The #4011 shape: customer parked on user.stripeCustomerId, org column null.
    const purgeCalls: Array<[string, string | null, readonly string[]]> = [];
    const deps: TeardownDeps = {
      purgeStripe: async (orgId, stripeCustomerId, extraCustomerIds) => {
        purgeCalls.push([orgId, stripeCustomerId, extraCustomerIds]);
        return okStripe({ actions: ["deleted Stripe customer cus_user"] });
      },
      softDelete: async () => true,
      hardDelete: async () => 1,
    };
    const report = await teardownTargets(
      [target({ userStripeCustomerId: "cus_user", orgs: [ownedOrg({ stripeCustomerId: null })] })],
      deps,
      false,
    );
    expect(purgeCalls).toEqual([["org_1", null, ["cus_user"]]]);
    expect(report.targets[0]!.userStripeCustomerId).toBe("cus_user");
    expect(report.targets[0]!.orgs[0]!.stripeActions).toContain("deleted Stripe customer cus_user");
  });

  it("passes an empty extra-ids array when the user has no user-level customer", async () => {
    const purgeCalls: Array<readonly string[]> = [];
    const deps: TeardownDeps = {
      purgeStripe: async (_o, _c, extraCustomerIds) => { purgeCalls.push(extraCustomerIds); return okStripe(); },
      softDelete: async () => true,
      hardDelete: async () => 1,
    };
    await teardownTargets(
      [target({ userStripeCustomerId: null, orgs: [ownedOrg({ stripeCustomerId: "cus_org" })] })],
      deps,
      false,
    );
    expect(purgeCalls).toEqual([[]]);
  });

  it("warns when an orphan user (no owned org) carries a user-level customer the purge can't reach", async () => {
    const deps: TeardownDeps = {
      purgeStripe: async () => okStripe(),
      softDelete: async () => true,
      hardDelete: async () => 0,
    };
    const report = await teardownTargets(
      [target({ email: "orphan+us@useatlas.dev", userStripeCustomerId: "cus_orphan", orgs: [] })],
      deps,
      false,
    );
    expect(report.targets[0]!.warnings.some((w) => w.includes("cus_orphan"))).toBe(true);
    expect(report.targets[0]!.warnings.some((w) => w.includes("manually"))).toBe(true);
    // Counted so the handler exits non-zero — a surviving billable customer
    // must not be reported as a clean teardown.
    expect(report.totals.orphanedUserCustomers).toBe(1);
  });

  it("warns when a user owns NO workspace (only non-owner memberships) but carries a customer", async () => {
    // The org-loop skips every non-owner membership, so the user-level customer
    // is never unioned into a purge — it must still be surfaced loudly (#4011),
    // not just in the zero-membership case.
    const calls: string[] = [];
    const deps: TeardownDeps = {
      purgeStripe: async () => { calls.push("purge"); return okStripe(); },
      softDelete: async () => true,
      hardDelete: async () => 0,
    };
    const report = await teardownTargets(
      [target({
        userStripeCustomerId: "cus_nonowner",
        orgs: [ownedOrg({ orgId: "org_shared", isOwner: false })],
      })],
      deps,
      false,
    );
    expect(calls).toEqual([]); // no purge ran — every membership is non-owner
    expect(report.targets[0]!.warnings.some((w) => w.includes("cus_nonowner"))).toBe(true);
    expect(report.targets[0]!.warnings.some((w) => w.includes("manually"))).toBe(true);
    expect(report.totals.orphanedUserCustomers).toBe(1);
  });

  it("does NOT warn (customer is reached) when the user owns at least one workspace", async () => {
    const deps: TeardownDeps = {
      purgeStripe: async () => okStripe({ actions: ["deleted Stripe customer cus_user"] }),
      softDelete: async () => true,
      hardDelete: async () => 1,
    };
    const report = await teardownTargets(
      [target({ userStripeCustomerId: "cus_user", orgs: [ownedOrg()] })],
      deps,
      false,
    );
    // An owned org's purge unions the customer in, so no manual-cleanup warning fires.
    expect(report.targets[0]!.warnings.some((w) => w.includes("manually"))).toBe(false);
    expect(report.totals.orphanedUserCustomers).toBe(0);
  });

  it("unions the user customer into EVERY owned org's purge (multi-org fan-out)", async () => {
    // A user owning 2 workspaces: the same user-level customer is passed to each
    // owned org's purge. The first deletes it, the rest hit resource_missing (a
    // no-op success) — proven safe, never orphaned, never double-counted.
    const extraArgs: Array<readonly string[]> = [];
    const deps: TeardownDeps = {
      purgeStripe: async (_o, _c, extraCustomerIds) => { extraArgs.push(extraCustomerIds); return okStripe(); },
      softDelete: async () => true,
      hardDelete: async () => 1,
    };
    await teardownTargets(
      [target({
        userStripeCustomerId: "cus_user",
        orgs: [ownedOrg({ orgId: "org_a" }), ownedOrg({ orgId: "org_b" })],
      })],
      deps,
      false,
    );
    expect(extraArgs).toEqual([["cus_user"], ["cus_user"]]);
  });

  it("skips a non-owner membership without calling any dep", async () => {
    const calls: string[] = [];
    const deps: TeardownDeps = {
      purgeStripe: async () => { calls.push("purge"); return okStripe(); },
      softDelete: async () => { calls.push("soft"); return true; },
      hardDelete: async () => { calls.push("hard"); return 0; },
    };
    const report = await teardownTargets(
      [target({ orgs: [ownedOrg({ orgId: "org_shared", isOwner: false })] })],
      deps,
      false,
    );
    expect(calls).toEqual([]);
    expect(report.targets[0]!.orgs[0]!.status).toBe("skipped-not-owner");
  });

  it("surfaces Stripe teardown warnings on the org result and counts them in totals", async () => {
    const deps: TeardownDeps = {
      purgeStripe: async () => okStripe({ warnings: ["Failed to delete Stripe customer cus_1: boom"] }),
      softDelete: async () => true,
      hardDelete: async () => 1,
    };
    const report = await teardownTargets([target({ orgs: [ownedOrg({ stripeCustomerId: "cus_1" })] })], deps, false);
    expect(report.targets[0]!.orgs[0]!.warnings).toContain("Failed to delete Stripe customer cus_1: boom");
    // A left-behind billable customer is a non-clean outcome — counted so the
    // handler can exit non-zero even though the row purge (status "torn-down") ran.
    expect(report.targets[0]!.orgs[0]!.status).toBe("torn-down");
    expect(report.totals.stripeWarnings).toBe(1);
  });

  it("warns (not silently) when soft-delete affects 0 rows", async () => {
    const deps: TeardownDeps = {
      purgeStripe: async () => okStripe(),
      softDelete: async () => false, // org concurrently reactivated/removed
      hardDelete: async () => 3,
    };
    const report = await teardownTargets([target({ orgs: [ownedOrg()] })], deps, false);
    expect(report.targets[0]!.orgs[0]!.warnings.some((w) => w.includes("Soft-delete affected 0 rows"))).toBe(true);
  });

  it("records a per-org failure and continues to the next org", async () => {
    const deps: TeardownDeps = {
      purgeStripe: async () => okStripe(),
      softDelete: async () => true,
      hardDelete: async (orgId) => {
        if (orgId === "org_bad") throw new Error("status check failed");
        return 5;
      },
    };
    const report = await teardownTargets(
      [target({ orgs: [ownedOrg({ orgId: "org_bad" }), ownedOrg({ orgId: "org_good" })] })],
      deps,
      false,
    );
    const [bad, good] = report.targets[0]!.orgs;
    expect(bad!.status).toBe("error");
    expect(bad!.warnings[0]).toContain("status check failed");
    expect(good!.status).toBe("torn-down");
    expect(report.totals).toMatchObject({ orgsTornDown: 1, errors: 1 });
  });

  it("warns for a not-found email and an orphan user with no workspace", async () => {
    const deps: TeardownDeps = {
      purgeStripe: async () => okStripe(),
      softDelete: async () => true,
      hardDelete: async () => 0,
    };
    const report = await teardownTargets(
      [
        target({ email: "ghost+us@useatlas.dev", userId: null, found: false, orgs: [] }),
        target({ email: "orphan+us@useatlas.dev", orgs: [] }),
      ],
      deps,
      false,
    );
    expect(report.targets[0]!.warnings[0]).toContain("No user row found");
    expect(report.targets[1]!.warnings[0]).toContain("no workspace membership");
  });
});

// --- handler arg-boundary (early exits, before any DB binding) ---

const errors: string[] = [];
const origConsoleError = console.error;
const origExit = process.exit;
let exitCode: number | null = null;

beforeEach(() => {
  errors.length = 0;
  exitCode = null;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__process_exit__:${exitCode}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  console.error = origConsoleError;
  process.exit = origExit;
});

async function expectExit1(args: string[]): Promise<void> {
  let caught: Error | null = null;
  try {
    await handleTeardownVerifyAccounts(args);
  } catch (err) {
    caught = err instanceof Error ? err : new Error(String(err));
  }
  expect(caught?.message).toBe("__process_exit__:1");
}

describe("handleTeardownVerifyAccounts arg boundary", () => {
  it("exits 1 when no --email is given", async () => {
    await expectExit1(["ops", "teardown-verify-accounts", "--region", "us"]);
    expect(errors.some((l) => l.includes("--email"))).toBe(true);
  });

  it("exits 1 when no region/url is resolvable (no DATABASE_URL fallback)", async () => {
    const origUs = process.env.ATLAS_REGION_US_DB_URL;
    delete process.env.ATLAS_REGION_US_DB_URL;
    try {
      await expectExit1(["ops", "teardown-verify-accounts", "--email", "matt+us@useatlas.dev"]);
      expect(errors.some((l) => l.includes("No region DB selected"))).toBe(true);
    } finally {
      if (origUs !== undefined) process.env.ATLAS_REGION_US_DB_URL = origUs;
    }
  });

  it("exits 1 on a non-throwaway email under the execute gate (no --force)", async () => {
    const origOk = process.env[TEARDOWN_OK_ENV];
    process.env[TEARDOWN_OK_ENV] = "1";
    try {
      await expectExit1([
        "ops",
        "teardown-verify-accounts",
        "--confirm",
        "--region",
        "us",
        "--email",
        "ceo@bigcustomer.com",
      ]);
      expect(errors.some((l) => l.includes("non-throwaway"))).toBe(true);
    } finally {
      if (origOk === undefined) delete process.env[TEARDOWN_OK_ENV];
      else process.env[TEARDOWN_OK_ENV] = origOk;
    }
  });
});

// --- dispatch wiring through handleOps ---

describe("handleOps teardown-verify-accounts wiring", () => {
  it("routes `ops teardown-verify-accounts` to the handler (exits 1 on missing --email)", async () => {
    let caught: Error | null = null;
    try {
      await handleOps(["ops", "teardown-verify-accounts", "--region", "us"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((l) => l.includes("--email"))).toBe(true);
  });

  it("usage text lists teardown-verify-accounts", async () => {
    let caught: Error | null = null;
    try {
      await handleOps(["ops", "unknown-subcommand"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((l) => l.includes("teardown-verify-accounts"))).toBe(true);
  });
});
