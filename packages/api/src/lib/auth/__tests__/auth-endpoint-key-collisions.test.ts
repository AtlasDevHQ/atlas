/**
 * Better Auth merges every plugin's `endpoints` into ONE FLAT MAP keyed by the
 * endpoint's OBJECT KEY, and builds its router from that merged map. Two
 * plugins exporting the same key is silent: the later one in `buildPlugins()`
 * replaces the earlier, and the earlier's PATH is never registered at all. No
 * warning, no duplicate-route error, no startup failure — just a route that
 * 404s in production while every test that calls the handler directly passes.
 *
 * That is #5404. `@better-auth/agent-auth` 0.6.2 exports `deviceCode` →
 * `/agent/device/code`; Better Auth's `deviceAuthorization` exports the same
 * key → `/device/code`, the RFC 8628 endpoint `atlas login` posts to. agent-auth
 * is pushed later, so from #4417 (2026-07-07) `POST /api/auth/device/code`
 * returned 404 on all four prod hosts and staging for five weeks, and the CLI
 * had no auth path anywhere.
 *
 * Two tests, deliberately not one:
 *
 *   1. The GENERAL invariant — no two plugins export the same key. This is the
 *      check that would have caught #5404 on the commit that introduced it, and
 *      it catches the next one for free. It is the primary reason this file
 *      exists.
 *   2. The SPECIFIC regression — `/device/code` is registered, and is Better
 *      Auth's, not agent-auth's. Kept separate because the general test would
 *      go green if someone "fixed" a future collision by deleting the device
 *      flow, and because this one names the symptom an operator would report.
 *
 * ⚠️ This asserts against `buildPlugins()` — the real array the auth singleton
 * is constructed from — never a hand-listed subset. A collision introduced by a
 * plugin nobody thought to list is the exact failure mode being guarded, so the
 * enumeration has to come from the source of truth.
 */
import { describe, expect, test } from "bun:test";

import { buildPlugins } from "@atlas/api/lib/auth/server";

type PluginEndpoint = { path?: string };
type LoadedPlugin = { id?: string; endpoints?: Record<string, PluginEndpoint> };

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

describe("Better Auth plugin endpoint keys", () => {
  test("no two plugins export the same endpoint key under different paths", () => {
    const collisions = [...endpointKeyOwners()]
      // Same key AND same path is harmless — the merged map ends up with the
      // route either way. Only a key whose owners disagree about the PATH can
      // silently unregister one of them, and that is the whole failure mode.
      .filter(([, owners]) => owners.length > 1 && new Set(owners.map((o) => o.path)).size > 1)
      .map(([key, owners]) => {
        const lost = owners
          .slice(0, -1)
          .map((o) => `${o.path} (${o.plugin})`)
          .join(", ");
        const won = owners[owners.length - 1];
        return `  key "${key}": ${won?.path} (${won?.plugin}) SHADOWS ${lost}`;
      });

    expect(
      collisions,
      collisions.length === 0
        ? ""
        : `Colliding Better Auth endpoint keys — the shadowed path(s) are NOT registered and will 404 ` +
            `in production (#5404):\n${collisions.join("\n")}\n\n` +
            `Fix by re-keying the endpoint in the Atlas-side plugin wrapper, preserving its path — see ` +
            `renameCollidingDeviceCodeKey in lib/auth/agent-auth-plugin.ts. Do NOT reorder buildPlugins(): ` +
            `that restores one path by unregistering the other.`,
    ).toEqual([]);
  });

  test("the RFC 8628 device-code endpoint is registered, and is the CLI's (#5404)", () => {
    // The path `packages/cli/src/lib/device-flow.ts` posts to. If this is
    // absent, `atlas login` is dead on every deployed environment.
    const owners = endpointKeyOwners();
    const registeredPaths = new Set(
      [...owners.values()].map((entries) => entries[entries.length - 1]?.path),
    );

    expect(registeredPaths).toContain("/device/code");
    // And agent-auth's device endpoint still has its own path — the fix
    // preserves both, rather than trading one for the other.
    expect(registeredPaths).toContain("/agent/device/code");
  });
});
