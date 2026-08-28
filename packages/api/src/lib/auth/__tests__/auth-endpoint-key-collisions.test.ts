/**
 * Better Auth resolves routes by ENDPOINT OBJECT KEY, not by path, and every
 * merge in that resolution is a silent last-write-wins. This file is the guard
 * on all three ways that loses a route (#5404).
 *
 * `getEndpoints` (better-auth `dist/api/index.mjs`) builds one flat map:
 *
 *   { ...29 core endpoints, ...pluginEndpoints, ok, error }
 *
 * where `pluginEndpoints` is itself `plugins.reduce((acc, p) => ({...acc,
 * ...p.endpoints}), {})`. So:
 *
 *   1. **plugin vs plugin** — the later plugin in `buildPlugins()` wins, and
 *      the earlier one's path is never registered.
 *   2. **plugin vs core** — a plugin key equal to one of the 29 core keys
 *      replaces the CORE route, on session-management keys like `listSessions`
 *      and `revokeSession`.
 *   3. **plugin vs `ok`/`error`** — those two are spread AFTER plugins, so the
 *      collision runs the other way and the PLUGIN's endpoint is dropped.
 *
 * None of these warns. Better Auth's own `checkEndpointConflicts` compares
 * PATHS, so a key collision between two different paths is invisible to it —
 * which is exactly why #5404 survived five weeks.
 *
 * That was `@better-auth/agent-auth` 0.6.2 exporting `deviceCode` →
 * `/agent/device/code` against `deviceAuthorization`'s `deviceCode` →
 * `/device/code`, the RFC 8628 endpoint `atlas login` posts to. agent-auth is
 * pushed later, so from #4417 (2026-07-07) `POST /api/auth/device/code`
 * returned 404 on all four prod hosts and staging, and the CLI had no auth path
 * anywhere. Every test that called the handler directly stayed green.
 *
 * ## Why the roster test below is not ceremony
 *
 * A collision check is only worth what its INPUT covers, and `buildPlugins()`
 * returns a different array depending on the environment: SCIM is behind
 * `isEnterpriseEnabled()`, Stripe behind `STRIPE_SECRET_KEY` + an internal DB.
 * A guard that silently checks 12 of 14 plugins reports "no collisions" while
 * two real plugins go unexamined — the same shape of false assurance as the
 * runbook step that had not been run. So the roster is asserted explicitly:
 * anything present but unknown, or known-always-present but missing, FAILS
 * here and forces a decision instead of quietly shrinking the sample.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildPlugins } from "@atlas/api/lib/auth/server";

/**
 * The core endpoint keys spread BEFORE `...pluginEndpoints`. A plugin exporting
 * any of these silently replaces the core route.
 *
 * ⚠️ Hand-copied from better-auth's `getEndpoints`, with no compile-time
 * coupling — the same trade `AGENT_AUTH_PREFIXES` makes in `agent-auth-gate.ts`
 * and for the same reason: better-auth exports the endpoint FACTORIES but not
 * the key map, so there is nothing to import. A bump that ADDS a core endpoint
 * leaves this list short, which fails OPEN for that one key. Re-read
 * `getEndpoints` when bumping better-auth; the list is 29 entries and takes a
 * minute to diff.
 */
const CORE_ENDPOINT_KEYS = [
  "signInSocial",
  "callbackOAuth",
  "getSession",
  "signOut",
  "signUpEmail",
  "signInEmail",
  "resetPassword",
  "verifyPassword",
  "verifyEmail",
  "sendVerificationEmail",
  "changeEmail",
  "changePassword",
  "setPassword",
  "updateSession",
  "updateUser",
  "deleteUser",
  "requestPasswordReset",
  "requestPasswordResetCallback",
  "listSessions",
  "revokeSession",
  "revokeSessions",
  "revokeOtherSessions",
  "linkSocialAccount",
  "listUserAccounts",
  "deleteUserCallback",
  "unlinkAccount",
  "refreshToken",
  "getAccessToken",
  "accountInfo",
] as const;

/**
 * Spread AFTER plugins, so the collision runs the other way: a plugin keying
 * `ok` or `error` has its OWN endpoint silently dropped.
 */
const CORE_KEYS_THAT_OUTRANK_PLUGINS = ["ok", "error"] as const;

/**
 * Core keys an Atlas plugin overrides ON PURPOSE, with the plugin that does it.
 *
 * `custom-session` replacing `getSession` is the documented Better Auth
 * mechanism for extending the session payload — that IS the plugin's job. It is
 * listed rather than pattern-matched so that a SECOND deliberate override has
 * to be added here by a human who thought about it.
 */
const DELIBERATE_CORE_OVERRIDES: Readonly<Record<string, string>> = {
  getSession: "custom-session",
};

/**
 * Plugins `buildPlugins()` returns in EVERY environment, test included.
 *
 * Asserted as a set so a new plugin cannot join the auth stack without either
 * being covered by the collision check or being listed as environment-gated
 * below with a reason.
 */
const ALWAYS_PRESENT_PLUGIN_IDS = [
  "bearer",
  "api-key",
  "harmony-email",
  "organization",
  "email-otp",
  "two-factor",
  "passkey",
  "jwt",
  "oauth-provider",
  "device-authorization",
  "agent-auth",
  "custom-session",
] as const;

/**
 * Plugins whose registration is environment-gated.
 *
 * `scim` is enabled below by setting `ATLAS_ENTERPRISE_ENABLED`, so it IS
 * covered. `stripe` additionally needs a configured internal DB and a live
 * Stripe client, which this suite deliberately does not stand up — so it is the
 * one plugin the collision check may not see, and saying so here is the point.
 * If Stripe ever starts exporting a key another plugin owns, this file will not
 * catch it; the `openapi-drift` and route-level suites are what would.
 */
const ENV_GATED_PLUGIN_IDS = ["scim", "stripe"] as const;

type LoadedPlugin = { id?: string; endpoints?: Record<string, { path?: string }> };

/** Every (key → owning plugin + path) pair across the real plugin array. */
function endpointKeyOwners(): Map<string, Array<{ plugin: string; path: string }>> {
  const owners = new Map<string, Array<{ plugin: string; path: string }>>();
  for (const plugin of buildPlugins() as unknown as LoadedPlugin[]) {
    for (const [key, endpoint] of Object.entries(plugin?.endpoints ?? {})) {
      const existing = owners.get(key) ?? [];
      existing.push({ plugin: plugin?.id ?? "<unidentified plugin>", path: endpoint?.path ?? "?" });
      owners.set(key, existing);
    }
  }
  return owners;
}

function pluginIds(): string[] {
  return (buildPlugins() as unknown as LoadedPlugin[]).map((p) => p?.id ?? "<unidentified plugin>");
}

describe("Better Auth plugin endpoint keys", () => {
  let priorEnterpriseFlag: string | undefined;
  let priorAuthSecret: string | undefined;

  beforeAll(() => {
    // Pulls SCIM into `buildPlugins()` so it is actually examined rather than
    // silently skipped. Set here rather than at module top-level per the
    // testing rules; `buildPlugins()` reads the gate at CALL time.
    priorEnterpriseFlag = process.env.ATLAS_ENTERPRISE_ENABLED;
    process.env.ATLAS_ENTERPRISE_ENABLED = "true";

    // #5493 — enabling SCIM now also requires a resolvable
    // `credentialHashSecret`. @better-auth/scim 1.7 digests managed bearer
    // credentials with an HMAC secret, and `buildPlugins()` derives it from
    // `BETTER_AUTH_SECRET` (see `resolveScimCredentialHashSecret`). A real
    // managed deploy always has that — it is the session-signing secret and
    // `getAuthInstance()` requires it regardless — but this file calls
    // `buildPlugins()` directly, so it has to supply one. Same set/restore
    // discipline as the enterprise flag above, for the same reason.
    priorAuthSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET ??= "test-auth-secret-at-least-32-chars-long!!";
  });

  // `--parallel` already gives this file its own global, so under the mandated
  // invocation this restore is redundant. It is here for the un-mandated one: a
  // bare `bun test` shares one process, and an enterprise flag left on would
  // leak into every sibling file that reads it — silently changing which
  // enterprise seams they see.
  //
  // ⚠️ It does NOT make this file safe to run in a shared process, and no
  // afterAll could: `bun test` (no `--parallel`) already fails a `-pg` suite
  // paired with `admin-brain-facts.test.ts` on cached auth-MODE module state,
  // and that reproduces with `candidates-pg.test.ts` — a file this branch never
  // touched. Pre-existing, and precisely what the `--parallel` mandate is for.
  afterAll(() => {
    if (priorEnterpriseFlag === undefined) delete process.env.ATLAS_ENTERPRISE_ENABLED;
    else process.env.ATLAS_ENTERPRISE_ENABLED = priorEnterpriseFlag;
    if (priorAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = priorAuthSecret;
  });

  test("the collision check examines the plugins it claims to", () => {
    const present = new Set(pluginIds());
    const known = new Set<string>([...ALWAYS_PRESENT_PLUGIN_IDS, ...ENV_GATED_PLUGIN_IDS]);

    const missing = ALWAYS_PRESENT_PLUGIN_IDS.filter((id) => !present.has(id));
    const unknown = [...present].filter((id) => !known.has(id));

    expect(
      { missing, unknown },
      "The plugin roster changed. A plugin that is present but UNKNOWN has never been " +
        "checked for endpoint-key collisions — add it to ALWAYS_PRESENT_PLUGIN_IDS (or to " +
        "ENV_GATED_PLUGIN_IDS with the gate that gates it). A plugin that is MISSING means " +
        "this environment stopped constructing it, so the collision check below silently " +
        "shrank its sample.",
    ).toEqual({ missing: [], unknown: [] });

    // SCIM specifically: enabled in beforeAll, so its absence would mean the
    // enablement broke and the plugin quietly left the sample.
    expect(present.has("scim")).toBe(true);
  });

  test("no two plugins export the same endpoint key", () => {
    const collisions = [...endpointKeyOwners()]
      .filter(([, owners]) => owners.length > 1)
      .map(([key, owners]) => {
        const won = owners[owners.length - 1];
        const lost = owners
          .slice(0, -1)
          .map((o) => `${o.path} (${o.plugin})`)
          .join(", ");
        // Same path is NOT harmless: the later plugin's endpoint object wins
        // wholesale, so the earlier plugin's HANDLER for that path is discarded
        // and the route answers with the wrong implementation. The message says
        // which of the two happened, because the fixes differ.
        const kind = new Set(owners.map((o) => o.path)).size > 1 ? "SHADOWS" : "REPLACES HANDLER OF";
        return `  key "${key}": ${won?.path} (${won?.plugin}) ${kind} ${lost}`;
      });

    expect(
      collisions,
      collisions.length === 0
        ? ""
        : `Colliding Better Auth endpoint keys (#5404). A SHADOWED path is NOT registered and ` +
            `will 404 in production; a REPLACED handler means the path answers with the wrong ` +
            `plugin's implementation:\n${collisions.join("\n")}\n\n` +
            `Fix by re-keying the endpoint in the Atlas-side plugin wrapper, preserving its path ` +
            `— see renameCollidingDeviceCodeKey in lib/auth/agent-auth-plugin.ts. Do NOT reorder ` +
            `buildPlugins(): that restores one route by losing the other.`,
    ).toEqual([]);
  });

  test("no plugin silently replaces a CORE Better Auth endpoint", () => {
    const owners = endpointKeyOwners();
    const overrides = CORE_ENDPOINT_KEYS.filter((key) => owners.has(key))
      .filter((key) => {
        const sanctioned = DELIBERATE_CORE_OVERRIDES[key];
        return !sanctioned || !owners.get(key)?.some((o) => o.plugin === sanctioned);
      })
      .map((key) => `  core "${key}" replaced by ${owners.get(key)?.map((o) => `${o.plugin}@${o.path}`).join(", ")}`);

    expect(
      overrides,
      overrides.length === 0
        ? ""
        : `A plugin exports a key that Better Auth spreads BEFORE plugin endpoints, so it ` +
            `replaces the CORE route on that path:\n${overrides.join("\n")}\n\n` +
            `If deliberate, add it to DELIBERATE_CORE_OVERRIDES with the owning plugin.`,
    ).toEqual([]);
  });

  test("no plugin endpoint is itself dropped by a core key spread after plugins", () => {
    const owners = endpointKeyOwners();
    // The opposite direction: `ok` and `error` come AFTER `...pluginEndpoints`,
    // so a plugin using either key loses its own route silently.
    const dropped = CORE_KEYS_THAT_OUTRANK_PLUGINS.filter((key) => owners.has(key)).map(
      (key) => `  plugin endpoint "${key}" (${owners.get(key)?.map((o) => o.path).join(", ")}) is overwritten by core`,
    );

    expect(dropped).toEqual([]);
  });

  test("the RFC 8628 device-code endpoint is registered, and is the CLI's (#5404)", () => {
    // The path `packages/cli/src/lib/device-flow.ts` posts to. If this is
    // absent, `atlas login` is dead on every deployed environment.
    const registeredPaths = new Set(
      [...endpointKeyOwners().values()].map((entries) => entries[entries.length - 1]?.path),
    );

    expect(registeredPaths).toContain("/device/code");
    // And agent-auth's device endpoint keeps its own path — the fix preserves
    // both rather than trading one for the other.
    expect(registeredPaths).toContain("/agent/device/code");
  });
});
