/**
 * Adversarial-fixture suite for the `/auth.md` ⇄ `.well-known` drift-parity
 * guard (#3825) — `scripts/check-auth-md-discovery-parity.ts`.
 *
 * The guard is defense-in-depth on top of #3824's structural sharing: it fails
 * the build when a maintainer HARDCODES a host, scope, or endpoint into the
 * `/auth.md` prose that diverges from what machine discovery (`.well-known`)
 * advertises from the same inputs.
 *
 * This suite locks in the two halves of that contract by driving the guard's
 * PURE checkers (`scopeParityViolations` / `hostParityViolations` /
 * `endpointParityViolations` / `collectViolations`) directly:
 *   - the guard PASSES (no violations) on a faithful, in-parity document, and
 *   - each drift vector PRODUCES a violation whose message NAMES the divergent
 *     value (acceptance criterion #3).
 *
 * Driving the pure checkers (rather than mutating real source and shelling out)
 * lets us inject every drift vector deterministically. The guard's end-to-end
 * pass on the real tree is covered by the script itself running in the `drift`
 * CI job.
 */

import { describe, it, expect } from "bun:test";

import {
  scopeParityViolations,
  issuableScopeViolations,
  hostParityViolations,
  endpointParityViolations,
  collectViolations,
  parseWellKnownScopes,
  FORBIDDEN_FRAGMENTS,
  type ResolvedHosts,
} from "../../../scripts/check-auth-md-discovery-parity";
import { ATLAS_OAUTH_SCOPES } from "@atlas/api/lib/auth/oauth-scopes";

// A minimal in-parity document: it names exactly the resolved hosts, exactly
// the advertised scopes, and only `.well-known` paths the router serves. The
// real builder's output is far richer, but parity is a property of the *facts*
// the doc names, so a compact faithful fixture exercises the checkers fully.
// The protected-resource path below uses the `{workspace_id}` placeholder
// verbatim because that is the literal in the guard's SERVED_WELL_KNOWN_PATHS;
// the real builder must emit the same placeholder (the script's live run
// against `buildAuthMd` is what guards that, not this hand-written fixture).
const HOSTS: ResolvedHosts = {
  authServerUri: "https://api.useatlas.dev/api/auth",
  resourceUri: "https://mcp.useatlas.dev/mcp",
};

const ADVERTISED_SCOPES = ["mcp:read", "mcp:write", "offline_access"] as const;

const FAITHFUL_DOC = [
  "# auth.md",
  "- Authorization server (issuer): `https://api.useatlas.dev/api/auth`",
  "- MCP resource server: `https://mcp.useatlas.dev/mcp`",
  "Metadata: `https://api.useatlas.dev/.well-known/oauth-authorization-server/api/auth`",
  "Per-workspace: `/.well-known/oauth-protected-resource/mcp/{workspace_id}`",
  "Scopes: `mcp:read`, `mcp:write`, `offline_access`.",
  "Go deeper: https://docs.useatlas.dev",
].join("\n");

describe("auth-md discovery parity — faithful document passes", () => {
  it("reports no violations when hosts, scopes, and endpoints all agree", () => {
    const violations = collectViolations({
      fixtures: [{ label: "us region", doc: FAITHFUL_DOC, hosts: HOSTS }],
      advertisedScopes: ADVERTISED_SCOPES,
    });
    expect(violations).toEqual([]);
  });

  it("each per-aspect checker is clean on the faithful document", () => {
    expect(scopeParityViolations(FAITHFUL_DOC, ADVERTISED_SCOPES)).toEqual([]);
    expect(hostParityViolations("us region", FAITHFUL_DOC, HOSTS)).toEqual([]);
    expect(endpointParityViolations("us region", FAITHFUL_DOC)).toEqual([]);
  });
});

// The eu fixture mirrors the second region `main()` passes, so the host/endpoint
// checks must fire per-fixture, while scope parity is deliberately checked once
// (it's region-invariant). These tests pin both halves of that contract so a
// later "iterate all fixtures for scopes too" change is a conscious one.
const EU_HOSTS: ResolvedHosts = {
  authServerUri: "https://api-eu.useatlas.dev/api/auth",
  resourceUri: "https://mcp-eu.useatlas.dev/mcp",
};
const EU_FAITHFUL_DOC = FAITHFUL_DOC.replaceAll(
  "https://api.useatlas.dev",
  "https://api-eu.useatlas.dev",
).replaceAll("https://mcp.useatlas.dev", "https://mcp-eu.useatlas.dev");

describe("auth-md discovery parity — collectViolations across region fixtures", () => {
  it("is clean when every region fixture and the shared scope set agree", () => {
    const violations = collectViolations({
      fixtures: [
        { label: "us region", doc: FAITHFUL_DOC, hosts: HOSTS },
        { label: "eu region", doc: EU_FAITHFUL_DOC, hosts: EU_HOSTS },
      ],
      advertisedScopes: ADVERTISED_SCOPES,
    });
    expect(violations).toEqual([]);
  });

  it("returns no violations for an empty fixtures slice (no doc to compare)", () => {
    // Regression guard: with no fixtures the host-independent scope check used
    // to run against an empty `""` document and report every advertised scope
    // as "absent from /auth.md" — a false positive. An empty slice is a misuse,
    // not a parity failure, so the contract is: no fixtures → no violations.
    const violations = collectViolations({
      fixtures: [],
      advertisedScopes: ADVERTISED_SCOPES,
    });
    expect(violations).toEqual([]);
  });

  it("flags a host drift that lives only in the SECOND (eu) fixture", () => {
    // The eu doc names the infra api-eu host where the brand-mirror mcp-eu host
    // is expected — proving host parity runs per-fixture, not just on the first.
    const driftedEuDoc = EU_FAITHFUL_DOC.replace(
      "https://mcp-eu.useatlas.dev/mcp",
      "https://api-eu.useatlas.dev/mcp",
    );
    const violations = collectViolations({
      fixtures: [
        { label: "us region", doc: FAITHFUL_DOC, hosts: HOSTS },
        { label: "eu region", doc: driftedEuDoc, hosts: EU_HOSTS },
      ],
      advertisedScopes: ADVERTISED_SCOPES,
    });
    expect(violations.some((v) => v.includes("[eu region]"))).toBe(true);
    expect(violations.some((v) => v.includes(EU_HOSTS.resourceUri))).toBe(true);
  });

  it("checks scope parity once (host-independent) against the first fixture's doc", () => {
    // Scope drift placed ONLY in the second fixture's doc is NOT reported,
    // because the set of `mcp:*` scopes the prose names does not vary by region
    // — collectViolations checks scopes against fixtures[0] alone. This pins the
    // intentional shortcut so changing it is a deliberate decision, not a slip.
    const euDocWithExtraScope = `${EU_FAITHFUL_DOC}\nAlso request \`mcp:admin\`.`;
    const violations = collectViolations({
      fixtures: [
        { label: "us region", doc: FAITHFUL_DOC, hosts: HOSTS },
        { label: "eu region", doc: euDocWithExtraScope, hosts: EU_HOSTS },
      ],
      advertisedScopes: ADVERTISED_SCOPES,
    });
    expect(violations.some((v) => v.includes("mcp:admin"))).toBe(false);
    // But the SAME drift in the first fixture's doc IS caught.
    const usDocWithExtraScope = `${FAITHFUL_DOC}\nAlso request \`mcp:admin\`.`;
    const caught = collectViolations({
      fixtures: [
        { label: "us region", doc: usDocWithExtraScope, hosts: HOSTS },
        { label: "eu region", doc: EU_FAITHFUL_DOC, hosts: EU_HOSTS },
      ],
      advertisedScopes: ADVERTISED_SCOPES,
    });
    expect(caught.some((v) => v.includes("mcp:admin"))).toBe(true);
  });
});

describe("auth-md discovery parity — scope drift fails, naming the scope", () => {
  it("fails when the prose names a scope .well-known does not advertise", () => {
    // A maintainer hardcodes `mcp:admin` into the prose; machine discovery only
    // lists mcp:read / mcp:write.
    const doc = `${FAITHFUL_DOC}\nAlso request \`mcp:admin\` for elevated access.`;
    const violations = scopeParityViolations(doc, ADVERTISED_SCOPES);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("mcp:admin"))).toBe(true);
    expect(violations.join("\n")).toContain("does NOT advertise");
  });

  it("fails when .well-known advertises a scope the prose never names", () => {
    // The prose only names mcp:read; machine discovery advertises mcp:write too.
    const doc = FAITHFUL_DOC.replace("`mcp:read`, `mcp:write`", "`mcp:read`");
    const violations = scopeParityViolations(doc, ADVERTISED_SCOPES);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("mcp:write"))).toBe(true);
    expect(violations.join("\n")).toContain("never names");
  });

  it("fails when the prose drops offline_access while .well-known advertises it", () => {
    // Regression for the DCR refresh-token break: `offline_access` is the one
    // non-`mcp:*` advertised scope, and the doc-token pattern must see it —
    // otherwise the doc silently drifts from what DCR clients register with.
    const doc = FAITHFUL_DOC.replace(", `offline_access`", "");
    const violations = scopeParityViolations(doc, ADVERTISED_SCOPES);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("offline_access"))).toBe(true);
    expect(violations.join("\n")).toContain("never names");
  });
});

describe("auth-md discovery parity — advertised scope must be issuable", () => {
  it("passes when every advertised scope is in the canonical union", () => {
    // ADVERTISED_SCOPES is a subset of what the auth server issues.
    expect(issuableScopeViolations(ADVERTISED_SCOPES)).toEqual([]);
  });

  it("every advertised scope is actually a member of ATLAS_OAUTH_SCOPES", () => {
    // The real advertised set the surfaces ship must be issuable — this is the
    // invariant that #4728 violated (a scope advertised but effectively not
    // requestable). Locks it against the live canonical union, not a fixture.
    const issuable = new Set<string>(ATLAS_OAUTH_SCOPES);
    for (const scope of ADVERTISED_SCOPES) {
      expect(issuable.has(scope)).toBe(true);
    }
  });

  it("fails, naming the scope, when an advertised scope is not issuable", () => {
    // Simulates renaming `offline_access` in ATLAS_OAUTH_SCOPES without updating
    // the advertised literal: the two discovery surfaces still agree with each
    // other, but authorize would reject it with `invalid_scope`.
    const violations = issuableScopeViolations([
      "mcp:read",
      "mcp:write",
      "offline_access",
      "mcp:bogus",
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("mcp:bogus");
    expect(violations[0]).toContain("invalid_scope");
  });

  it("is wired into collectViolations", () => {
    const violations = collectViolations({
      fixtures: [{ label: "us region", doc: FAITHFUL_DOC, hosts: HOSTS }],
      advertisedScopes: ["mcp:read", "mcp:write", "offline_access", "mcp:bogus"],
    });
    expect(violations.some((v) => v.includes("mcp:bogus"))).toBe(true);
  });
});

describe("auth-md discovery parity — host drift fails, naming the host", () => {
  it("fails when a foreign host literal is hardcoded into the prose", () => {
    // A stray, un-advertised regional host baked into the doc.
    const foreignHost = "api-apac.useatlas.dev";
    const doc = `${FAITHFUL_DOC}\nFor APAC use \`https://${foreignHost}/api/auth\`.`;
    const violations = hostParityViolations("us region", doc, HOSTS);
    expect(violations.length).toBeGreaterThan(0);
    // Assert on the bare host (no scheme) plus the foreign-host phrasing so the
    // message is the right violation. (Matching the hostname rather than a full
    // URL literal also keeps this a string-assertion, not a URL-substring check.)
    expect(
      violations.some((v) => v.includes(foreignHost) && v.includes("neither the")),
    ).toBe(true);
  });

  it("fails when the prose omits the resolved auth-server issuer URI", () => {
    const doc = FAITHFUL_DOC.replace(
      "https://api.useatlas.dev/api/auth",
      "https://auth.example.test/api/auth",
    );
    const violations = hostParityViolations("us region", doc, HOSTS);
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.some((v) => v.includes(HOSTS.authServerUri) && v.includes("does not name")),
    ).toBe(true);
  });

  it("fails when the prose omits the resolved MCP resource (brand-mirror) host", () => {
    // The infra `api.*` host where the brand-mirror `mcp.*` resource is expected.
    const doc = FAITHFUL_DOC.replace(
      "https://mcp.useatlas.dev/mcp",
      "https://api.useatlas.dev/mcp",
    );
    const violations = hostParityViolations("us region", doc, HOSTS);
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.some((v) => v.includes(HOSTS.resourceUri) && v.includes("brand-mirror")),
    ).toBe(true);
  });
});

describe("auth-md discovery parity — endpoint drift fails, naming the endpoint", () => {
  it("fails when the prose names a WorkOS-conformance endpoint Atlas does not serve", () => {
    const doc = `${FAITHFUL_DOC}\nVerified agents: \`POST /agent/identity\` with an \`identity_assertion\`.`;
    const violations = endpointParityViolations("us region", doc);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("/agent/identity"))).toBe(true);
    expect(violations.some((v) => v.includes("identity_assertion"))).toBe(true);
  });

  // Iterate the exported set so EVERY listed fragment is exercised by the
  // checker — not just the two (`/agent/identity`, `identity_assertion`) that
  // co-occur in the fixture above. (Test and checker share the same
  // FORBIDDEN_FRAGMENTS constant, so this can't catch a typo'd entry — both
  // would move together — but it does catch a checker change that stops
  // honoring the full set, e.g. `urn:workos:` / `agent_auth` going unguarded.)
  it.each([...FORBIDDEN_FRAGMENTS])(
    "fails when the prose names the forbidden fragment %p",
    (fragment) => {
      const doc = `${FAITHFUL_DOC}\nDo not do this: ${fragment}`;
      const violations = endpointParityViolations("us region", doc);
      expect(violations.some((v) => v.includes(fragment))).toBe(true);
    },
  );

  it("fails when the prose points at a .well-known path the router does not serve", () => {
    const doc = `${FAITHFUL_DOC}\nSee \`/.well-known/oauth-protected-resource/mcp\` (no workspace).`;
    const violations = endpointParityViolations("us region", doc);
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.some((v) => v.includes("/.well-known/oauth-protected-resource/mcp")),
    ).toBe(true);
  });
});

describe("auth-md discovery parity — .well-known scope extraction", () => {
  it("parses the scopes_supported literal the protected-resource metadata advertises", () => {
    const source = `scopes_supported: ["mcp:read", "mcp:write"],`;
    expect(parseWellKnownScopes(source, "fixture")).toEqual(["mcp:read", "mcp:write"]);
  });

  it("tracks a scope added to the .well-known literal", () => {
    const source = `scopes_supported: ["mcp:read", "mcp:write", "mcp:admin"],`;
    expect(parseWellKnownScopes(source, "fixture")).toEqual([
      "mcp:read",
      "mcp:write",
      "mcp:admin",
    ]);
  });
});
