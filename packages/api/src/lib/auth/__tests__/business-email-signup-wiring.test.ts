/**
 * Wiring test for business-email-only signup (#3650, ADR-0018).
 *
 * The deny logic (business-email.ts) and the normalizer (the `emailHarmony`
 * plugin) are each covered in isolation, but their *security value* depends on
 * the composition actually attaching them to the Better Auth signup path:
 *
 *   • `emailHarmony` in `buildPlugins()` output, declaring a UNIQUE
 *     `normalizedEmail` field + collapsing `+alias`/dot/case variants (the
 *     teeth behind one-trial-per-user).
 *   • `assertBusinessEmail` invoked from `databaseHooks.user.create.before` in
 *     `buildAuthOptions()`, OUTSIDE the bootstrap-role try/catch, so a
 *     disposable/freemium signup is rejected with the typed
 *     `business_email_required` code rather than silently admitted.
 *
 * This is the same "well-tested logic + missing wiring assertion = silent prod
 * regression" shape that databaseHooks-wiring.test.ts guards. A refactor that
 * dropped the `emailHarmony(...)` push or the `assertBusinessEmail(user.email)`
 * line would pass every unit test yet reopen consumer/disposable signups.
 *
 * No mock.module needed: the deny path throws before any DB/CRM/email side
 * effect, and the allowed path resolves through `computeBootstrapRole` with no
 * internal DB (bootstrapAdmin "none" + database undefined → no query).
 */

import { describe, it, expect } from "bun:test";
import { APIError } from "better-auth/api";
import { emailHarmony } from "better-auth-harmony";
import { buildPlugins, buildAuthOptions, parseAuthSecret } from "../server";
import { BUSINESS_EMAIL_REQUIRED_CODE } from "../business-email";

function authDeps(plugins: ReturnType<typeof buildPlugins>) {
  return {
    env: process.env,
    secret: parseAuthSecret("test-secret-at-least-32-characters-long"),
    baseURL: undefined,
    database: undefined,
    cookieDomain: undefined,
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

  it("normalizes +alias / dot / case variants to a single normalizedEmail (collapse)", async () => {
    // The plugin's normalization runs from its init() databaseHook regardless of
    // the disabled route-validation matcher.
    const before = emailHarmony().init().options.databaseHooks.user.create.before;

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

describe("databaseHooks.user.create.before — business-email deny wiring", () => {
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

  it("allows a legitimate business-domain signup (no business-email throw)", async () => {
    // bootstrapAdmin "none" + database undefined → computeBootstrapRole returns
    // promote:false with no DB query, so a clean business email falls through.
    expect(await rejection("founder@acme.com")).toBeUndefined();
  });
});
