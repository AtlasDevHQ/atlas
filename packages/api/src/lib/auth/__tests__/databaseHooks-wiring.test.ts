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
      if (/SELECT\s+role\s+FROM\s+"user"/i.test(sql)) return rows([{ role: "member" }]);
      if (/SELECT\s+plan_tier\s+FROM\s+organization/i.test(sql)) return rows([{ plan_tier: "free" }]);
      if (/FROM\s+sso_providers/i.test(sql)) return rows([]);
      if (/FROM\s+member/i.test(sql)) return rows([{ organizationId: "org_welcome" }]);
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
    cookieDomain: undefined,
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
