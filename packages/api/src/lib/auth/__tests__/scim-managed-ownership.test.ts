/**
 * Contract-pinning tests for how GHSA-j8v8-g9cx-5qf4 (HIGH,
 * `@better-auth/scim`) is closed on the 1.7 line.
 *
 * ── What changed, and why this file was rewritten ──────────────────────
 *
 * Until #5493 these tests pinned `providerOwnership: { enabled: true }` —
 * the advisory's supported workaround on 1.6.x, where the fix existed only
 * in a 1.7.0 prerelease. That workaround stamped an owner onto each
 * personal SCIM provider so the plugin's access check
 *
 *   } else if (provider.userId && provider.userId !== userId) throw
 *
 * actually fired instead of short-circuiting on a NULL `userId` and letting
 * ANY authenticated user read, delete or regenerate another user's provider
 * token. Migration 0184 sealed the rows that predated the flag.
 *
 * 1.7 closes the hole STRUCTURALLY rather than by configuration, so there is
 * no flag left to pin. The four management routes that carried the
 * vulnerable check — `/scim/generate-token`,
 * `/scim/{get,list,delete}-provider-connection` — are gone from HTTP
 * entirely. Their operations survive as `serverOnly` endpoints, callable
 * from application code but not reachable over the wire, so there is no
 * unauthenticated surface left to own.
 *
 * These tests therefore pin the STRUCTURAL guarantee, in the same spirit as
 * the ones they replace: assert the mechanism, not the presence of a flag,
 * so the pin fails if upstream ever re-exposes management over HTTP.
 *
 * The authorization control that `beforeSCIMTokenGenerated` used to carry
 * did not vanish — it moved outward to the Atlas admin route that wraps
 * `rotateSCIMManagedCredential`. That half (a non-admin cannot mint a SCIM
 * credential) is covered in `api/__tests__/admin-scim.test.ts`, because it
 * is now our check on our route rather than a plugin hook.
 */

import { describe, expect, it } from "bun:test";
import { scim } from "@better-auth/scim";

type ScimPlugin = ReturnType<typeof scim>;

/**
 * Build the plugin exactly as `buildPlugins()` does — an empty static
 * `connections` list plus the managed-connection catalog, which is the
 * shape Atlas runs because connections are provisioned per organization at
 * runtime rather than declared in code.
 */
function buildPlugin(): ScimPlugin {
  return scim({
    connections: [],
    managedConnections: { credentialHashSecret: "x".repeat(32) },
  });
}

/** Endpoints the plugin exposes, as `[name, path, serverOnly]` triples. */
function endpoints(plugin: ScimPlugin): { name: string; path: unknown; serverOnly: boolean }[] {
  const eps = (plugin.endpoints ?? {}) as Record<
    string,
    { path?: unknown; options?: { metadata?: { SERVER_ONLY?: unknown } } }
  >;
  return Object.entries(eps).map(([name, ep]) => ({
    name,
    path: ep?.path,
    serverOnly: ep?.options?.metadata?.SERVER_ONLY === true,
  }));
}

describe("SCIM management surface is not reachable over HTTP (GHSA-j8v8-g9cx-5qf4)", () => {
  it("no longer exposes the four 1.6 management routes that carried the vulnerable check", () => {
    // The advisory's actual attack surface. If any of these ever comes back
    // with a path, the hole this issue closed is reachable again.
    const withdrawn = [
      "/scim/generate-token",
      "/scim/get-provider-connection",
      "/scim/list-provider-connections",
      "/scim/delete-provider-connection",
    ];
    const paths = endpoints(buildPlugin())
      .map((e) => e.path)
      .filter((p): p is string => typeof p === "string");
    for (const route of withdrawn) {
      expect(paths).not.toContain(route);
    }
  });

  it("marks every managed-connection and credential operation SERVER_ONLY, with no route", () => {
    // These are the operations that replaced the withdrawn routes. Each must
    // be callable from application code (so the admin surface can wrap it
    // behind `canGenerateSCIMToken`) and NOT be addressable over HTTP.
    const management = endpoints(buildPlugin()).filter((e) =>
      /ManagedConnection|ManagedCredential/.test(e.name),
    );
    // Guard against the filter silently matching nothing if upstream renames.
    expect(management.length).toBeGreaterThanOrEqual(6);
    for (const ep of management) {
      expect(ep.serverOnly).toBe(true);
      expect(ep.path).toBeUndefined();
    }
  });

  it("still routes the SCIM 2.0 protocol endpoints — provisioning is unaffected", () => {
    // The negative control for the test above: withdrawing management must
    // not have withdrawn the IdP-facing protocol surface too.
    const paths = endpoints(buildPlugin())
      .map((e) => e.path)
      .filter((p): p is string => typeof p === "string");
    expect(paths).toContain("/scim/v2/Users");
    expect(paths).toContain("/scim/v2/Groups");
    expect(paths).toContain("/scim/v2/ServiceProviderConfig");
  });
});

describe("SCIM ownership is now a required column, not a nullable one", () => {
  it("records the creating actor as REQUIRED on connections and credentials", () => {
    // This is the upstream replacement for `providerOwnership` plus 0184's
    // sentinel. Our version was a NULLABLE column with a reserved-UUID
    // convention layered on top precisely because nothing backfilled it;
    // upstream's is non-null by construction, so the "ownerless row" state
    // that the advisory turned on cannot be represented at all.
    const schema = buildPlugin().schema as Record<
      string,
      { fields?: Record<string, { required?: boolean }> }
    > | undefined;

    for (const table of ["scimManagedConnection", "scimManagedCredential"]) {
      const createdBy = schema?.[table]?.fields?.createdBy;
      expect(createdBy).toBeDefined();
      expect(createdBy?.required).toBe(true);
    }
  });

  it("no longer declares the `scimProvider` table at all", () => {
    // The table migration 0184 sealed. Its absence is why 0184 is retired
    // and why the raw SQL in `ee/auth/scim.ts`, `scim-provenance.ts` and
    // `db/internal.ts` had to move to the connection/binding model — none of
    // those are template-string-checked, so this assertion is the only
    // compile-adjacent signal that the old table is gone.
    const schema = buildPlugin().schema as Record<string, unknown> | undefined;
    expect(schema?.scimProvider).toBeUndefined();
  });
});
