/**
 * Wiring test for Better Auth's signup-time hooks (#2841).
 *
 * ── The risk this closes ────────────────────────────────────────────
 * Signup-time side effects run from two Better Auth plugin hooks, each
 * with thorough unit coverage in isolation but — until this file —
 * NO test proving the composition actually attaches them:
 *
 *   • organizationHooks.afterCreateOrganization (in `buildPlugins`)
 *       → assignSaasTrial (org-owner promotion was removed in #2890 —
 *         the creator is already member.role='owner')
 *       → stampOrgRegion (the process IS the region, ADR-0024 — region is
 *         stamped from the ambient ATLAS_API_REGION at creation)
 *   • databaseHooks.user.create.after (in `buildAuthOptions`)
 *       → dispatchSignupCrmLead, the deferred welcome-email path,
 *         _autoProvisionSsoMember
 *
 * The per-helper test files (`assign-saas-trial.test.ts`,
 * `dispatch-signup-crm-lead.test.ts`,
 * `sso-provisioning.test.ts`) each self-document the gap: "Better Auth
 * closes over its plugin options, so the wiring isn't introspectable" and
 * "this cannot detect a refactor that removes the helper call from the
 * hook." That is exactly the "well-tested logic + missing wiring
 * assertion = silent prod regression" shape that bit the chat plugin four
 * times (#2628 channelAllowed, #2630 botToken, #2676 orgId, #2680
 * reaction-back key mismatch). A refactor that deletes the hook
 * composition in `buildPlugins()` / `buildAuthOptions()` would pass every
 * existing test yet break signup in prod (SaaS workspaces stuck on
 * plan_tier="free", no CRM lead,
 * no welcome email, no SSO auto-join).
 *
 * ── Why we assert via downstream effects, not helper spies ───────────
 * These are named helpers defined *inside* `server.ts`, called from the
 * hook bodies through lexical bindings (`await assignSaasTrial(...)`)
 * rather than through the module's export object; the welcome email is an
 * inline deferred block in the hook that dynamically imports `onUserSignup`.
 * `mock.module("../server")` cannot intercept an intra-module call — and
 * mocking the module under test would defeat the point. So instead of
 * spying the helpers, we drive the *real, composed* hook and assert each
 * one's unique observable side effect:
 *
 *   assignSaasTrial        → UPDATE organization SET plan_tier = 'trial'
 *   dispatchSignupCrmLead  → SaasCrm.upsertLead({ source: "signup" })
 *   welcome-email path     → setTimeout(…, 2000) → onUserSignup(…)
 *   _autoProvisionSsoMember→ SELECT … FROM sso_providers
 *
 * This is strictly stronger than a static shape check: it proves the hook
 * is wired into the *actual composed config* (the organization plugin
 * instance / the options object handed to `betterAuth()`), so deleting
 * either the `organizationHooks:` wiring or any individual `await helper()`
 * line trips a failure here. The DB seam uses `_resetPool` (real
 * `db/internal`, injected recording pool) — the same seam the per-helper
 * tests use — so we don't have to enumerate that module's large export
 * surface. The enterprise / email / CRM collaborators are `mock.module`'d
 * with all named exports per CLAUDE.md.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";
import {
  SaasCrm,
  type SaasCrmLeadInput,
  type SaasCrmShape,
} from "@atlas/api/lib/effect/services";

// ── Mock state (controlled per-test) ────────────────────────────────

let runEnterpriseImpl: (p: unknown) => Promise<unknown> = async () => undefined;
const upsertLeadCalls: SaasCrmLeadInput[] = [];
const onUserSignupCalls: Array<{ userId: string; email: string; orgId: string }> = [];

// _autoProvisionSsoMember early-returns unless enterprise is enabled —
// force it on so the hook reaches its `sso_providers` SELECT.
mock.module("@atlas/api/lib/effect/enterprise-config", () => ({
  isEnterpriseEnabled: () => true,
}));

// dispatchSignupCrmLead runs its program through `runEnterprise`. Capture
// it and resolve the `SaasCrm` Tag through a recording double. All named
// exports mocked (CLAUDE.md) — a partial mock surfaces as a cross-file
// SyntaxError under bun's `--parallel` workers (slice 6 / #2802).
mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: (p: unknown) => runEnterpriseImpl(p),
  getEnterpriseRuntime: () => ({
    runPromise: <A, E>(p: Effect.Effect<A, E, never>) => Effect.runPromise(p),
  }),
  EnterpriseLayer: Layer.empty,
}));

// The welcome-email path dynamically imports this module inside its
// deferred setTimeout callback. Record onUserSignup; stub the rest.
mock.module("@atlas/api/lib/email/hooks", () => ({
  onUserSignup: (u: { userId: string; email: string; orgId: string }) => {
    onUserSignupCalls.push(u);
  },
  onDatabaseConnected: () => {},
  onFirstQueryExecuted: () => {},
  onTeamMemberInvited: () => {},
  onFeatureExplored: () => {},
}));

// ── Import the module under test AFTER mocks ────────────────────────

const { buildPlugins, buildAuthOptions, parseAuthSecret } = await import("../server");

// ── Recording internal-DB pool ──────────────────────────────────────

interface RecordedQuery {
  sql: string;
  params?: unknown[];
}

let queries: RecordedQuery[] = [];

function rows(r: Array<Record<string, unknown>>) {
  return { rows: r, rowCount: r.length };
}

/**
 * A pool whose `query` records every call and returns canned rows keyed
 * by SQL shape — just enough to drive each helper down its happy path so
 * the wiring is observable. `sso_providers` returns empty so
 * `_autoProvisionSsoMember` proves invocation (the SELECT fires) then
 * stops before the member-limit / INSERT machinery.
 */
function makeRecordingPool(): InternalPool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      // #3159 ban-guard lookup (DB-clock `ban_active`): only "banned_user" is
      // banned; everyone else (incl. the other describe blocks' user ids) reads
      // back not-banned.
      if (/ban_active/i.test(sql)) {
        return rows(params?.[0] === "banned_user" ? [{ banned: true, ban_active: true }] : [{ banned: false, ban_active: false }]);
      }
      if (/SELECT\s+role\s+FROM\s+"user"/i.test(sql)) return rows([{ role: "member" }]);
      if (/SELECT\s+plan_tier\s+FROM\s+organization/i.test(sql)) return rows([{ plan_tier: "free" }]);
      if (/FROM\s+sso_providers/i.test(sql)) return rows([]);
      // #3426 one-trial-per-user eligibility lookup (also matches the
      // generic /FROM member/ arm below, so dispatch it first): empty =
      // "no trial consumed" so assignSaasTrial takes the trial branch the
      // wiring assertion pins.
      if (/trial_ends_at\s+IS\s+NOT\s+NULL/i.test(sql)) return rows([]);
      // #3469 atomic trial claim: return the inserted row (claim won) so
      // the hook proceeds to the trial UPDATE the wiring assertion pins.
      if (/INSERT\s+INTO\s+user_trial_grants/i.test(sql)) {
        return rows([{ user_id: params?.[0] }]);
      }
      // "cli_multi" belongs to TWO orgs (the multi-workspace branch — no
      // active org is auto-selected, ADR-0025 §6); everyone else is single-org.
      if (/FROM\s+member/i.test(sql)) {
        return rows(
          params?.[0] === "cli_multi"
            ? [{ organizationId: "org_a" }, { organizationId: "org_b" }]
            : [{ organizationId: "org_welcome" }],
        );
      }
      return rows([]);
    },
  } as unknown as InternalPool;
}

function recordingSaasCrmLayer(): Layer.Layer<SaasCrm> {
  return Layer.succeed(SaasCrm, {
    available: true,
    upsertLead: (input: SaasCrmLeadInput) => {
      upsertLeadCalls.push(input);
      return Effect.void;
    },
  } as unknown as SaasCrmShape);
}

function saasConfig(): ResolvedConfig {
  // SaaS deploy mode is the only branch where assignSaasTrial writes — see
  // assign-saas-trial.test.ts for the same shape.
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode: "saas",
  };
}

function authDeps(plugins: ReturnType<typeof buildPlugins>) {
  return {
    env: process.env,
    secret: parseAuthSecret("test-secret-at-least-32-characters-long"),
    baseURL: undefined,
    // undefined → Better Auth's in-memory adapter. `hasInternalDB()` is
    // driven at runtime by DATABASE_URL + the injected pool, not by this.
    database: undefined,
    cookiePrefix: "atlas",
    socialProviders: undefined,
    plugins,
    trustedOrigins: ["https://app.useatlas.dev"],
    bootstrapAdmin: { mode: "none" as const },
  };
}

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeEach(() => {
  queries = [];
  upsertLeadCalls.length = 0;
  onUserSignupCalls.length = 0;
  // hasInternalDB() reads DATABASE_URL; getInternalDB()/internalQuery use
  // the injected pool.
  process.env.DATABASE_URL = "postgresql://test/test";
  _resetPool(makeRecordingPool());
  _setConfigForTest(saasConfig());
  runEnterpriseImpl = async (program) => {
    await Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, never, SaasCrm>, recordingSaasCrmLayer()),
    );
  };
});

afterEach(() => {
  _resetPool(null);
  _setConfigForTest(null);
});

afterAll(() => {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

// ── organizationHooks.afterCreateOrganization ───────────────────────

describe("organizationHooks.afterCreateOrganization wiring", () => {
  /**
   * Reach the hook through the *composed* organization plugin instance.
   * Better Auth stores the passed options on the constructed plugin under
   * `.options` (1.6.x); older lines shipped them under `._config`. We probe
   * both — the same defensive lookup `server.test.ts` uses for
   * `requireEmailVerificationOnInvitation` — so a future Better Auth bump
   * surfaces as a clear "hook not wired" failure rather than a confusing
   * `undefined`. Reading it here (rather than from an extracted helper) is
   * what proves the `organizationHooks:` wiring is attached to the plugin.
   */
  function getAfterCreateOrganization() {
    const plugins = buildPlugins();
    const org = plugins.find((p: { id?: string }) => p.id === "organization");
    expect(org, "organization plugin must be present in buildPlugins() output").toBeDefined();
    type OrgOptions = { organizationHooks?: { afterCreateOrganization?: unknown } };
    const opts =
      (org as { options?: OrgOptions }).options
      ?? (org as { _config?: OrgOptions })._config;
    const hook = opts?.organizationHooks?.afterCreateOrganization;
    expect(
      typeof hook,
      "afterCreateOrganization must be wired into the organization plugin's organizationHooks",
    ).toBe("function");
    return hook as (args: { user: { id: string }; organization: { id: string } }) => Promise<void>;
  }

  it("invokes assignSaasTrial and does NOT promote user.role (#2890)", async () => {
    const afterCreateOrganization = getAfterCreateOrganization();

    await afterCreateOrganization({ user: { id: "user_org_1" }, organization: { id: "org_1" } });

    const sqls = queries.map((q) => q.sql);

    // #2890 removed promoteOrgOwnerToAdmin — the org creator is already
    // member.role='owner' via the org plugin's creatorRole default, so no
    // user.role write should fire here. Pin the absence so a regression
    // re-adding the promotion is caught.
    expect(
      sqls.some((s) => /UPDATE\s+"user"\s+SET\s+role\s*=\s*'admin'/i.test(s)),
      "afterCreateOrganization must NOT write user.role='admin' (promotion was removed in #2890)",
    ).toBe(false);

    // assignSaasTrial: SELECT current tier, then flip free → trial, bound
    // to THIS hook's org id.
    expect(
      sqls.some((s) => /SELECT\s+plan_tier\s+FROM\s+organization/i.test(s)),
      "assignSaasTrial should read the current plan tier",
    ).toBe(true);
    const trialUpdate = queries.find((q) =>
      /UPDATE\s+organization\s+SET\s+plan_tier\s*=\s*'trial'/i.test(q.sql),
    );
    expect(
      trialUpdate?.params,
      "assignSaasTrial must be wired — expected the trial-assignment UPDATE bound to the new org's id",
    ).toContain("org_1");
  });

  it("stamps the ambient region on the new org (the process IS the region, ADR-0024)", async () => {
    // Drive getApiRegion() to a non-null value so stampOrgRegion reaches its
    // region UPDATE — proving the `await stampOrgRegion(args)` line is wired
    // into the composed hook. Env set+restored in-test so siblings don't see it.
    const prevApiRegion = process.env.ATLAS_API_REGION;
    process.env.ATLAS_API_REGION = "us";
    try {
      const afterCreateOrganization = getAfterCreateOrganization();

      await afterCreateOrganization({ user: { id: "user_org_region" }, organization: { id: "org_region" } });

      const regionStamp = queries.find((q) => /UPDATE\s+organization\s+SET\s+region\s*=/i.test(q.sql));
      expect(
        regionStamp?.params,
        "stampOrgRegion must be wired — expected the region UPDATE bound to the new org's id",
      ).toContain("org_region");
    } finally {
      if (prevApiRegion === undefined) delete process.env.ATLAS_API_REGION;
      else process.env.ATLAS_API_REGION = prevApiRegion;
    }
  });
});

// ── databaseHooks.user.create.after ─────────────────────────────────

describe("databaseHooks.user.create.after wiring", () => {
  function getUserCreateAfter() {
    const options = buildAuthOptions(authDeps(buildPlugins()));
    const hook = (options as {
      databaseHooks?: { user?: { create?: { after?: unknown } } };
    }).databaseHooks?.user?.create?.after;
    expect(
      typeof hook,
      "user.create.after must be composed in buildAuthOptions",
    ).toBe("function");
    return hook as (user: { id: string; email: string; name?: string }) => Promise<void>;
  }

  it("invokes dispatchSignupCrmLead, the welcome-email path, and _autoProvisionSsoMember", async () => {
    const userCreateAfter = getUserCreateAfter();

    // The welcome-email path is deferred via setTimeout(…, 2000). Capture
    // the scheduled callback instead of waiting (or flaking) on real time.
    const realSetTimeout = globalThis.setTimeout;
    let scheduledDelay: number | undefined;
    let scheduledCb: (() => unknown) | undefined;
    globalThis.setTimeout = ((cb: () => unknown, ms?: number) => {
      scheduledCb = cb;
      scheduledDelay = ms;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof globalThis.setTimeout;

    try {
      await userCreateAfter({ id: "user_db_1", email: "newuser@acme.com", name: "New User" });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // dispatchSignupCrmLead → SaasCrm.upsertLead with a signup-sourced lead.
    expect(
      upsertLeadCalls,
      "dispatchSignupCrmLead must be wired — expected one SaasCrm.upsertLead call",
    ).toHaveLength(1);
    expect(upsertLeadCalls[0]).toMatchObject({ source: "signup", email: "newuser@acme.com" });

    // _autoProvisionSsoMember → SELECT … FROM sso_providers (domain lookup).
    expect(
      queries.some((q) => /FROM\s+sso_providers/i.test(q.sql)),
      "_autoProvisionSsoMember must be wired — expected the sso_providers lookup",
    ).toBe(true);

    // welcome-email path: scheduled at 2000ms; running the callback reaches
    // onUserSignup with the org id resolved from the membership lookup.
    expect(scheduledDelay, "welcome email must be deferred via setTimeout(…, 2000)").toBe(2000);
    expect(typeof scheduledCb).toBe("function");
    await scheduledCb?.();
    expect(
      onUserSignupCalls,
      "welcome-email path must be wired — expected one onUserSignup call",
    ).toHaveLength(1);
    expect(onUserSignupCalls[0]).toMatchObject({
      userId: "user_db_1",
      email: "newuser@acme.com",
      orgId: "org_welcome",
    });
  });
});

// ── databaseHooks.session.create.before — ban guard wiring (#3159) ───
//
// `enforceBanOnSessionCreate` is unit-tested in isolation, but its security
// value depends on the hook actually calling it, awaiting it, and letting its
// BANNED_USER throw propagate (it runs OUTSIDE the hook's try/catch on purpose).
// A refactor that moved the call inside the try/catch, dropped the await, or
// reordered it after the org-auto-set return would silently make ban
// enforcement-at-create inert while every unit test stayed green. Drive the
// real composed hook and assert both the propagation and the short-circuit.
describe("databaseHooks.session.create.before — ban guard wiring (#3159)", () => {
  function getSessionCreateBefore() {
    const options = buildAuthOptions(authDeps(buildPlugins()));
    const hook = (options as {
      databaseHooks?: { session?: { create?: { before?: unknown } } };
    }).databaseHooks?.session?.create?.before;
    expect(
      typeof hook,
      "session.create.before must be composed in buildAuthOptions",
    ).toBe("function");
    return hook as (
      session: {
        userId: string;
        activeOrganizationId?: string | null;
      },
      ctx?: { path?: string; request?: { url?: string } },
    ) => Promise<{ data?: { origin?: string; activeOrganizationId?: string } } | undefined>;
  }

  it("refuses session creation for a banned user and short-circuits the active-org lookup", async () => {
    const before = getSessionCreateBefore();

    let thrown: unknown;
    try {
      await before({ userId: "banned_user" });
    } catch (err) {
      thrown = err;
    }
    expect(
      thrown,
      "enforceBanOnSessionCreate must propagate — a banned user's session creation must be refused, not swallowed by the hook's try/catch",
    ).toBeDefined();

    // The guard runs before the org-auto-set logic, so a banned user must not
    // even reach the `member` lookup below it.
    expect(
      queries.some((q) => /FROM\s+member/i.test(q.sql)),
      "the ban guard must short-circuit before the active-org member lookup",
    ).toBe(false);
  });

  it("allows session creation for a non-banned user (guard runs, then falls through)", async () => {
    const before = getSessionCreateBefore();

    // Must not throw.
    await before({ userId: "ok_user" });

    // The guard's ban lookup fired (proving it is wired), and being not-banned
    // it fell through to the active-org member lookup.
    expect(
      queries.some((q) => /ban_active/i.test(q.sql)),
      "the ban guard's lookup must run on every session create",
    ).toBe(true);
    expect(
      queries.some((q) => /FROM\s+member/i.test(q.sql)),
      "a non-banned user must fall through to the active-org lookup",
    ).toBe(true);
  });

  // ── #4043 / ADR-0025 — origin=cli stamping wiring ──────────────────
  // The detector (isDeviceTokenSessionContext) and the downgrade
  // (buildCustomSessionPayload given origin:"cli") are unit-tested in
  // isolation; these drive the REAL composed hook to prove it CONNECTS them —
  // stamping origin='cli' when the session is created under /device/token. A
  // refactor that drops the ctx arg or the patch.origin line would silently
  // leave every cli session unmarked → resolving the user-level role → a
  // platform_admin's portable bearer carrying cross-tenant authority.
  it("stamps origin='cli' (and the auto-selected org) for a session created under /device/token", async () => {
    const before = getSessionCreateBefore();
    const result = await before({ userId: "cli_user" }, { path: "/device/token" });
    // The single-org user gets BOTH the cli marker AND the auto-set active org
    // in one patch (the composed-patch path).
    expect(result?.data?.origin).toBe("cli");
    expect(result?.data?.activeOrganizationId).toBe("org_welcome");
  });

  it("detects /device/token via the request.url fallback when ctx.path is absent", async () => {
    const before = getSessionCreateBefore();
    const result = await before(
      { userId: "cli_user2" },
      { request: { url: "https://api.useatlas.dev/api/auth/device/token" } },
    );
    expect(result?.data?.origin).toBe("cli");
  });

  it("does NOT stamp origin for a normal web login, but still auto-sets the active org", async () => {
    const before = getSessionCreateBefore();
    const result = await before({ userId: "web_user" }, { path: "/sign-in/email" });
    // Control: no cli marker. The active-org auto-set return shape is asserted
    // here (it was previously only proven to FIRE, not to be RETURNED) — guards
    // the composed-patch refactor against silently dropping the org.
    expect(result?.data?.origin).toBeUndefined();
    expect(result?.data?.activeOrganizationId).toBe("org_welcome");
  });

  it("stamps origin='cli' for a MULTI-workspace login WITHOUT auto-selecting an org (ADR-0025 §6)", async () => {
    const before = getSessionCreateBefore();
    // The cli marker and the active-org auto-set are independent patch fields;
    // a multi-org user must get origin='cli' but NO active org (the picker is
    // the deferred handoff). Pins that a refactor can't couple origin-stamping
    // to org-resolution — which would leave multi-org cli sessions unmarked and
    // resolving the user-level role (a platform_admin escalation).
    const result = await before({ userId: "cli_multi" }, { path: "/device/token" });
    expect(result?.data?.origin).toBe("cli");
    expect(result?.data?.activeOrganizationId).toBeUndefined();
  });
});
