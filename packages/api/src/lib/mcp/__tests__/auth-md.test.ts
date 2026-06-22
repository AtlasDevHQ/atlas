/**
 * Unit tests for the pure `/auth.md` document builder (#3824).
 *
 * Good tests assert the *content contract* of the returned Markdown — that
 * it names the resolved auth-server URI, the resolved MCP resource host, the
 * advertised scopes, the onboarding endpoint, and the `start_trial` field
 * contract — given controlled inputs. We assert the presence and correctness
 * of these load-bearing facts, NOT exact prose wording, so copy edits don't
 * break tests.
 */

import { describe, it, expect } from "bun:test";
import { buildAuthMd, type BuildAuthMdOptions } from "../auth-md";

const BASE_OPTS: BuildAuthMdOptions = {
  authServerUri: "https://api.useatlas.dev/api/auth",
  issuerBaseUri: "https://api.useatlas.dev",
  resourceUri: "https://mcp.useatlas.dev/mcp",
  scopes: [
    { name: "mcp:read", grants: "query workspace data through the MCP endpoint" },
    { name: "mcp:write", grants: "reserved for future write paths" },
  ],
  onboardingPath: "/mcp/onboarding",
  docsUrl: "https://docs.useatlas.dev",
};

describe("buildAuthMd — content contract", () => {
  it("names the resolved authorization-server issuer URI", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("https://api.useatlas.dev/api/auth");
  });

  it("names the resolved MCP resource host", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("https://mcp.useatlas.dev/mcp");
  });

  it("points at the RFC 8414 authorization-server metadata at the issuer base host", () => {
    const md = buildAuthMd(BASE_OPTS);
    // The metadata URL is built from the explicit issuer base, not by
    // string-stripping the issuer URI — so it names the host the discovery
    // documents are actually served from.
    expect(md).toContain(
      "https://api.useatlas.dev/.well-known/oauth-authorization-server/api/auth",
    );
  });

  it("uses the supplied issuer base verbatim for the metadata URL (no /api/auth round-trip)", () => {
    // A pathological issuer base without the conventional `/api/auth` suffix
    // must still produce a well-formed metadata URL rooted at the base —
    // proving the builder no longer reconstructs the base by regex-stripping
    // the issuer URI (which would silently double the path).
    const md = buildAuthMd({
      ...BASE_OPTS,
      authServerUri: "https://auth.example.test/oauth",
      issuerBaseUri: "https://auth.example.test",
    });
    expect(md).toContain(
      "https://auth.example.test/.well-known/oauth-authorization-server/api/auth",
    );
    expect(md).not.toContain("/oauth/.well-known");
  });

  it("points at the RFC 9728 protected-resource metadata path", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain(
      "/.well-known/oauth-protected-resource/mcp/{workspace_id}",
    );
  });

  it("resolved hosts flow through to the document verbatim (no hard-coding)", () => {
    // The builder hard-codes no host — whatever the route resolves (here,
    // eu-region hosts) must appear verbatim in the output. The auth-server
    // and resource hosts are supplied independently because machine discovery
    // advertises them independently (the auth-server is the api.* issuer; the
    // resource is the mcp.* brand-mirror — see the route + well-known.ts).
    const md = buildAuthMd({
      ...BASE_OPTS,
      authServerUri: "https://api-eu.useatlas.dev/api/auth",
      issuerBaseUri: "https://api-eu.useatlas.dev",
      resourceUri: "https://mcp-eu.useatlas.dev/mcp",
    });
    expect(md).toContain("https://api-eu.useatlas.dev/api/auth");
    expect(md).toContain("https://mcp-eu.useatlas.dev/mcp");
    expect(md).toContain(
      "https://api-eu.useatlas.dev/.well-known/oauth-authorization-server/api/auth",
    );
    // The us-region hosts must not leak in when the eu hosts were supplied.
    expect(md).not.toContain("https://api.useatlas.dev/api/auth");
    expect(md).not.toContain("https://mcp.useatlas.dev/mcp");
  });

  it("lists every advertised scope (add-a-scope shows up)", () => {
    const md = buildAuthMd({
      ...BASE_OPTS,
      scopes: [
        ...BASE_OPTS.scopes,
        { name: "mcp:admin", grants: "a brand-new scope" },
      ],
    });
    expect(md).toContain("mcp:read");
    expect(md).toContain("mcp:write");
    // A scope added to the canonical constant must surface automatically.
    expect(md).toContain("mcp:admin");
  });

  it("names the canonical onboarding endpoint, the Streamable HTTP transport, and start_trial", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("/mcp/onboarding");
    expect(md).toContain("start_trial");
    // Clarifies the transport so a client doesn't reach for the deprecated
    // HTTP+SSE transport the `/sse`-named path used to imply (#3886).
    expect(md).toContain("Streamable HTTP");
    // The legacy alias is still surfaced for clients pinned to it.
    expect(md).toContain("/mcp/onboarding/sse");
  });

  it("documents the start_trial input contract (email, orgName, turnstileToken)", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("email");
    expect(md).toContain("orgName");
    expect(md).toContain("turnstileToken");
  });

  it("documents the start_trial output contract (workspaceId, connectUrl, state)", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("workspaceId");
    expect(md).toContain("connectUrl");
    expect(md).toContain("state");
    // The grace/locked state semantics must be present.
    expect(md).toContain("grace");
    expect(md).toContain("locked");
  });

  it("describes DCR + PKCE connect and the web-claim handoff", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("PKCE");
    expect(md).toMatch(/Dynamic Client Registration|DCR/);
    // The human-claim handoff that lifts the grace window into the full trial.
    expect(md.toLowerCase()).toContain("claim");
    expect(md).toContain("14-day");
  });

  it("links to the canonical Atlas docs", () => {
    const md = buildAuthMd(BASE_OPTS);
    expect(md).toContain("https://docs.useatlas.dev");
  });

  it("does NOT name a /agent/identity endpoint or WorkOS conformance machinery", () => {
    // The required backstop (#3824 § Testing): the doc must never advertise an
    // endpoint Atlas does not serve. `/agent/identity`, `identity_assertion`,
    // and the `urn:workos:*` grant types are explicitly Out of Scope.
    const md = buildAuthMd(BASE_OPTS);
    expect(md).not.toContain("/agent/identity");
    expect(md).not.toContain("identity_assertion");
    expect(md).not.toContain("urn:workos:");
    expect(md).not.toContain("agent_auth");
  });

  it("leaks no secrets or connection strings", () => {
    // Built from already-resolved public configuration. The auth-server issuer
    // host (an `api*.useatlas.dev` host) is NOT a leak — it is exactly what the
    // .well-known protected-resource metadata advertises as `authorization_servers`
    // (#3824 user story #15), and an agent must bind to the same one. What must
    // never appear is a secret, a connection string, or a credential.
    const md = buildAuthMd(BASE_OPTS);
    expect(md).not.toMatch(/postgres(ql)?:\/\//i);
    expect(md).not.toMatch(/mysql:\/\//i);
    expect(md).not.toMatch(/\b(secret|api[_-]?key|password|bearer\s+ey)\b/i);
  });
});
