/**
 * Wiring test for business-email-only signup (#3650, ADR-0018).
 *
 * The deny logic (business-email.ts) and the normalizer (the `emailHarmony`
 * plugin) are each covered in isolation, but their *security value* depends on
 * the composition actually attaching them to the Better Auth signup path:
 *
 *   • `emailHarmony` in `buildPlugins()` output, declaring a UNIQUE
 *     `normalizedEmail` field + collapsing `+alias`/dot/case variants (the
 *     teeth behind one-trial-per-user) — and still normalizing through the
 *     EXACT instance Atlas wires (with `matchers.validation: []` disabling only
 *     route validation, not normalization).
 *   • `assertBusinessEmail` invoked from `databaseHooks.user.create.before` in
 *     `buildAuthOptions()`, OUTSIDE the bootstrap-role try/catch, so a
 *     disposable/freemium signup is rejected with the typed
 *     `business_email_required` code rather than silently admitted — and only
 *     in SaaS deploy mode.
 *
 * This is the same "well-tested logic + missing wiring assertion = silent prod
 * regression" shape that databaseHooks-wiring.test.ts guards. A refactor that
 * dropped the `emailHarmony(...)` push or the `assertBusinessEmail(user.email)`
 * line — or one where a harmony upgrade folded normalization behind the same
 * disabled matcher — would pass every isolated unit test yet reopen
 * consumer/disposable signups.
 *
 * No mock.module needed: the deny path throws before any DB/CRM/email side
 * effect, and the allowed path resolves through `computeBootstrapRole` with no
 * internal DB (bootstrapAdmin "none" + database undefined → no query). Deploy
 * mode is set via `_setConfigForTest` (same pattern as assign-saas-trial.test).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { APIError } from "better-auth/api";
import { buildPlugins, buildAuthOptions, parseAuthSecret } from "../server";
import {
  BUSINESS_EMAIL_REQUIRED_CODE,
  PLUS_ADDRESSING_NOT_ALLOWED_CODE,
} from "../business-email";
import { _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";

function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

function authDeps(plugins: ReturnType<typeof buildPlugins>) {
  return {
    env: process.env,
    secret: parseAuthSecret("test-secret-at-least-32-characters-long"),
    baseURL: undefined,
    database: undefined,
    cookiePrefix: "atlas",
    socialProviders: undefined,
    plugins,
    trustedOrigins: ["https://app.useatlas.dev"],
    bootstrapAdmin: { mode: "none" as const },
  };
}

function getUserCreateBefore() {
  const options = buildAuthOptions(authDeps(buildPlugins()));
  const hook = (options as {
    databaseHooks?: { user?: { create?: { before?: unknown } } };
  }).databaseHooks?.user?.create?.before;
  expect(typeof hook, "user.create.before must be composed in buildAuthOptions").toBe("function");
  return hook as (user: { id: string; email: string; name?: string }) => Promise<unknown>;
}

describe("emailHarmony plugin wiring", () => {
  it("is present in buildPlugins() with a unique, non-returned normalizedEmail field", () => {
    const plugins = buildPlugins();
    const harmony = plugins.find((p: { id?: string }) => p.id === "harmony-email");
    expect(harmony, "emailHarmony must be wired into the Better Auth plugin array").toBeDefined();

    const field = (harmony as {
      schema?: { user?: { fields?: { normalizedEmail?: { unique?: boolean; input?: boolean; returned?: boolean } } } };
    }).schema?.user?.fields?.normalizedEmail;
    expect(field, "emailHarmony must contribute the normalizedEmail schema field").toBeDefined();
    // UNIQUE is the one-trial-per-user teeth; input:false / returned:false keep
    // it server-owned and out of the enumeration-safe signup response.
    expect(field?.unique).toBe(true);
    expect(field?.input).toBe(false);
    expect(field?.returned).toBe(false);
  });

  it("normalizes +alias / dot / case variants via the COMPOSED instance (matchers.validation:[] disables only route validation)", async () => {
    // Reach into the exact plugin object Atlas wires — i.e. the one constructed
    // with `matchers: { validation: [] }` in buildPlugins() — and run ITS
    // normalization databaseHook (installed via init()). Constructing a fresh
    // `emailHarmony()` here would test the default plugin, not the one we ship,
    // and miss a regression where disabling validation also disabled
    // normalization (the exact risk in this feature's rationale).
    const harmony = buildPlugins().find((p: { id?: string }) => p.id === "harmony-email");
    expect(harmony, "emailHarmony must be wired into the Better Auth plugin array").toBeDefined();
    const before = (harmony as {
      init: () => {
        options: { databaseHooks: { user: { create: { before: (u: never) => Promise<unknown> } } } };
      };
    }).init().options.databaseHooks.user.create.before;

    const norm = async (email: string) => {
      const r = await before({ id: "u", email } as never);
      expect(r && typeof r === "object" && "data" in r, `expected normalized data for ${email}`).toBe(true);
      return (r as { data: { normalizedEmail?: string } }).data.normalizedEmail;
    };

    // Case variants on a business domain collapse — so a duplicate signup trips
    // the unique index instead of minting a second trial.
    expect(await norm("Alice@Acme.com")).toBe(await norm("alice@acme.com"));
    // +alias / dot variants collapse for known providers (gmail engine).
    expect(await norm("john.doe+trial@gmail.com")).toBe(await norm("JohnDoe@gmail.com"));
  });
});

describe("databaseHooks.user.create.before — business-email deny wiring (SaaS)", () => {
  beforeEach(() => {
    _setConfigForTest(configWithDeployMode("saas"));
  });
  afterAll(() => {
    _setConfigForTest(null);
  });

  async function rejection(email: string): Promise<unknown> {
    const before = getUserCreateBefore();
    try {
      await before({ id: "u_deny", email });
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("rejects a freemium signup with the typed business_email_required code", async () => {
    const err = await rejection("user@gmail.com");
    expect(err, "freemium signup must be rejected by the composed hook").toBeInstanceOf(APIError);
    expect((err as APIError).body?.code).toBe(BUSINESS_EMAIL_REQUIRED_CODE);
  });

  it("rejects a disposable signup with the typed business_email_required code", async () => {
    const err = await rejection("user@mailinator.com");
    expect(err, "disposable signup must be rejected by the composed hook").toBeInstanceOf(APIError);
    expect((err as APIError).body?.code).toBe(BUSINESS_EMAIL_REQUIRED_CODE);
  });

  it("rejects a Google-OAuth-shaped freemium signup (social path goes through the same hook)", async () => {
    // Social-provider signups provision through the same user.create.before, so
    // a consumer-domain OAuth identity is denied identically to a web signup.
    const err = await rejection("person@gmail.com");
    expect(err, "social-provider freemium signup must be rejected by the composed hook").toBeInstanceOf(APIError);
    expect((err as APIError).body?.code).toBe(BUSINESS_EMAIL_REQUIRED_CODE);
  });

  it("allows a legitimate business-domain signup (no business-email throw)", async () => {
    // bootstrapAdmin "none" + database undefined → computeBootstrapRole returns
    // promote:false with no DB query, so a clean business email falls through.
    expect(await rejection("founder@acme.com")).toBeUndefined();
  });

  it("rejects a plus-addressed business signup with the typed plus-addressing code (#4091)", async () => {
    const err = await rejection("user+trial@acme.com");
    expect(err, "plus-addressed business signup must be rejected by the composed hook").toBeInstanceOf(APIError);
    expect((err as APIError).body?.code).toBe(PLUS_ADDRESSING_NOT_ALLOWED_CODE);
  });

  it("rejects a plus-addressed freemium signup with the business-email code (business-email gate runs first)", async () => {
    // A freemium domain is denied by the business-email gate before the
    // plus-addressing check runs — so the more fundamental "use your work email"
    // reason wins. Confirms deterministic ordering, not a generic duplicate error.
    const err = await rejection("user+1@gmail.com");
    expect(err, "plus-addressed freemium signup must still be rejected").toBeInstanceOf(APIError);
    expect((err as APIError).body?.code).toBe(BUSINESS_EMAIL_REQUIRED_CODE);
  });

  it("allows plus-addressing on the exempt useatlas.dev domain (verify-prod-signup throwaways)", async () => {
    // Atlas's own /verify-prod-signup E2E flow signs up plus-addressed
    // @useatlas.dev accounts (matt+us@useatlas.dev); the exemption keeps them
    // signable, and the ops teardown-verify-accounts guard keys on that plus-tag.
    expect(await rejection("matt+us@useatlas.dev")).toBeUndefined();
  });
});

describe("databaseHooks.user.create.before — business-email policy is SaaS-only", () => {
  afterAll(() => {
    _setConfigForTest(null);
  });

  async function rejection(email: string): Promise<unknown> {
    const before = getUserCreateBefore();
    try {
      await before({ id: "u_selfhost", email });
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("does NOT deny a freemium signup in self-hosted mode (operator may bootstrap with any domain)", async () => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    expect(await rejection("operator@gmail.com")).toBeUndefined();
  });

  it("does NOT deny when deploy mode is unresolved (config null → not saas)", async () => {
    _setConfigForTest(null);
    expect(await rejection("operator@gmail.com")).toBeUndefined();
  });

  it("does NOT deny a plus-addressed signup in self-hosted mode (#4091 is SaaS-only)", async () => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    expect(await rejection("operator+tag@acme.com")).toBeUndefined();
  });
});
