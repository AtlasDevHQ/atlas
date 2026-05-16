/**
 * Wire-shape parser test for `/admin` Overview (#2489).
 *
 * The page renders org-scoped tiles (workspace name, plan tier + trial
 * countdown, queries(24h), org-scoped connections, org-scoped entities)
 * from the API response. The API side is covered in
 * `packages/api/src/api/__tests__/admin.test.ts` — this test guards the
 * tile-data projection from drifting away from the wire contract, so a
 * future API rename or field-drop is caught at parse time instead of
 * rendering blank tiles in production.
 */

import { describe, expect, test } from "bun:test";
import {
  FALLBACK_OVERVIEW,
  parseOverview,
} from "../overview-data";

describe("parseOverview", () => {
  test("projects an org-scoped response to the tile-data shape", () => {
    const wire = {
      connections: 3,
      entities: 17,
      plugins: 2,
      queriesLast24h: 42,
      workspace: {
        id: "org-acme",
        name: "Acme Co",
        slug: "acme",
        planTier: "trial",
        planDisplayName: "Starter Trial",
        trialEndsAt: "2026-06-01T00:00:00Z",
        region: "us-east",
      },
    };
    const parsed = parseOverview(wire);
    expect(parsed.connections).toBe(3);
    expect(parsed.entities).toBe(17);
    expect(parsed.queriesLast24h).toBe(42);
    expect(parsed.workspace?.name).toBe("Acme Co");
    expect(parsed.workspace?.planTier).toBe("trial");
    expect(parsed.workspace?.trialEndsAt).toBe("2026-06-01T00:00:00Z");
    expect(parsed.workspace?.region).toBe("us-east");
  });

  test("falls back gracefully when workspace and queriesLast24h are absent (self-hosted / no DB)", () => {
    // Self-hosted dev without an internal DB returns workspace=null and
    // queriesLast24h=null. The page renders "—" for queries and hides the
    // workspace/plan tiles. Anything else is a regression.
    const parsed = parseOverview({
      connections: 1,
      entities: 5,
      plugins: 0,
      queriesLast24h: null,
      workspace: null,
    });
    expect(parsed.workspace).toBeNull();
    expect(parsed.queriesLast24h).toBeNull();
    expect(parsed.connections).toBe(1);
  });

  test("rejects platform-wide fields silently — deployment scaffold lives on /platform", () => {
    // Defense-in-depth: even if the API regresses and starts returning
    // `metrics` / `glossaryTerms` / `pluginHealth` on /admin, the parser
    // never lifts them onto the tile-data shape. The TypeScript surface
    // forbids it; this test pins the runtime behavior too.
    const parsed = parseOverview({
      connections: 1,
      entities: 5,
      plugins: 0,
      metrics: 99,
      glossaryTerms: 88,
      pluginHealth: [{ id: "x", status: "healthy" }],
    });
    expect(Object.keys(parsed)).toEqual(
      Object.keys(FALLBACK_OVERVIEW),
    );
  });

  test("missing numeric fields default to zero, not NaN", () => {
    const parsed = parseOverview({});
    expect(parsed.connections).toBe(0);
    expect(parsed.entities).toBe(0);
    expect(parsed.plugins).toBe(0);
    expect(parsed.queriesLast24h).toBeNull();
  });

  test("poolWarnings are not lifted onto the workspace tile (#2489 platform leak guard)", () => {
    // `poolWarnings` exposes deployment-wide capacity config
    // (maxOrgs × maxConnections × numDatasources). Even if the API
    // accidentally surfaces it on /admin/overview, the parser must not
    // lift it onto the workspace tile data. Lives only on /platform.
    const parsed = parseOverview({
      connections: 1,
      poolWarnings: ["over-provisioned 2.5×"],
    });
    expect(parsed).not.toHaveProperty("poolWarnings");
  });
});
