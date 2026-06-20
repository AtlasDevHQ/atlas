/**
 * `/auth.md` agent-onboarding discovery document (#3824).
 *
 * A small Markdown file hosted at the conventional `/auth.md` path that
 * doubles as (a) human integrator documentation and (b) a discoverable
 * runtime artifact an agent (Claude Desktop, Cursor, ChatGPT, the Atlas
 * SDK, any `auth.md`-aware MCP client) can read to self-navigate Atlas's
 * registration flow. It narrates the end-to-end "provision a trial, then
 * connect" journey in one place, tying together the OAuth 2.1 + DCR + PKCE
 * machinery, the RFC 9728/8414 discovery documents, and the `start_trial`
 * self-serve provisioning path that Atlas already ships.
 *
 * Borrowed from WorkOS's emerging `auth.md` convention — we adopt the
 * file's *name, path, and spirit* (a discoverable Markdown onboarding
 * artifact) and point agents at the real OAuth/DCR/`start_trial` mechanics.
 * This file documents ONLY flows Atlas actually serves. It does NOT
 * describe the WorkOS agent-verified machinery (`POST /agent/identity`,
 * `identity_assertion`, the `urn:workos:*` grant types, the `agent_auth`
 * metadata block) — Atlas serves none of those, and a discovery document
 * must never advertise an endpoint that returns 404. (See #3824 § Out of
 * Scope; the WorkOS-verified flow is a deliberately deferred future
 * direction noted as prose only.)
 *
 * Drift safety: this is a PURE builder. It hard-codes no host and no scope.
 * The route feeds it the SAME resolved auth-server issuer URI and MCP
 * resource host that back the `.well-known` discovery documents
 * (`well-known.ts:buildAuthServerUri` / `buildResourceUri`, including the
 * `api*.useatlas.dev` → `mcp*.useatlas.dev` regional brand-mirror) and the
 * canonical `ATLAS_OAUTH_SCOPES` constant. Sharing the source of truth is
 * what structurally prevents the human-readable file from advertising
 * endpoints, hosts, or scopes that disagree with machine discovery.
 */

/** A single advertised OAuth scope plus its human-readable grant. */
export interface AuthMdScope {
  /** The scope token, e.g. `mcp:read`. */
  readonly name: string;
  /** One-line description of what requesting the scope grants. */
  readonly grants: string;
}

export interface BuildAuthMdOptions {
  /**
   * Authorization-server issuer URI — the same value the protected-resource
   * metadata advertises in `authorization_servers`
   * (`well-known.ts:buildAuthServerUri`), e.g. `https://api.useatlas.dev/api/auth`.
   */
  readonly authServerUri: string;
  /**
   * Base host the `.well-known` discovery documents are served from — i.e.
   * the issuer URI with the `/api/auth` path stripped, e.g.
   * `https://api.useatlas.dev`. Passed explicitly (rather than re-derived
   * from `authServerUri`) so the builder carries no hidden "issuer must end
   * in /api/auth" precondition. The route resolves it from the same base
   * `buildAuthServerUri` uses, so the discovery-document URL the doc names
   * stays in lockstep with where the metadata is actually served.
   */
  readonly issuerBaseUri: string;
  /**
   * MCP resource-server host (the `<host>/mcp` audience the
   * protected-resource metadata advertises, including the regional
   * brand-mirror), e.g. `https://mcp.useatlas.dev/mcp`. We surface the
   * host so the doc names the same audience an agent's token must bind to.
   */
  readonly resourceUri: string;
  /**
   * Advertised scopes, derived from the canonical scope constant so a scope
   * added to the OAuth provider surfaces here automatically. Only the MCP
   * scopes are documented (the doc is about connecting an MCP actor); the
   * caller filters the canonical list.
   */
  readonly scopes: readonly AuthMdScope[];
  /**
   * Path of the unauthenticated onboarding MCP endpoint that hosts the
   * `start_trial` tool, e.g. `/mcp/onboarding/sse`. Named explicitly so an
   * agent knows where to call it.
   */
  readonly onboardingPath: string;
  /**
   * Public docs base an integrator can follow to go deeper, e.g.
   * `https://docs.useatlas.dev`.
   */
  readonly docsUrl: string;
}

/**
 * Render the `/auth.md` document body. Pure: no I/O, no request object, no
 * env reads — every host, scope, and path is supplied by the caller. The
 * route is responsible for resolving the inputs from the shared
 * `.well-known` host-resolution helpers and the canonical scope constant.
 */
export function buildAuthMd(opts: BuildAuthMdOptions): string {
  const { authServerUri, issuerBaseUri, resourceUri, scopes, onboardingPath, docsUrl } =
    opts;

  // The auth-server issuer lives at `<issuerBaseUri>/api/auth`; the
  // `.well-known` discovery documents live at the base, not under the issuer
  // path. The caller supplies the base so the doc points an agent at the
  // canonical metadata locations without this builder reconstructing it.
  const authServerMetadataUrl = `${issuerBaseUri}/.well-known/oauth-authorization-server/api/auth`;
  const protectedResourceMetadataPath =
    "/.well-known/oauth-protected-resource/mcp/{workspace_id}";

  const scopeLines = scopes
    .map((s) => `- \`${s.name}\` — ${s.grants}`)
    .join("\n");

  return `# Connecting an agent to Atlas

This document is for autonomous agents (and the humans integrating them).
It describes how to register with Atlas and connect an MCP client, from a
cold start with no account, workspace, or credentials. Every flow named
here already exists; this file introduces no new authentication mechanism —
it is a single discovery surface that ties Atlas's existing OAuth 2.1 + DCR
+ PKCE machinery to its self-serve trial path.

Atlas is a deploy-anywhere text-to-SQL data-analyst agent exposed over the
Model Context Protocol. An agent connects by attaching a *hosted actor* to a
workspace via OAuth 2.1 (authorization-code + PKCE), having registered
itself with Dynamic Client Registration (DCR). If you do not have a
workspace yet, start with the self-serve trial path below.

## Hosts

- **Authorization server (issuer):** \`${authServerUri}\`
- **MCP resource server:** \`${resourceUri}\`

Tokens you obtain must bind to the resource-server audience exactly as the
protected-resource metadata advertises it.

## Discover the machine-readable metadata

Atlas serves standard discovery documents. Read these to locate the
authorize, token, and DCR registration endpoints — do not hard-code them.

- **Authorization-server metadata (RFC 8414):**
  \`${authServerMetadataUrl}\`
  Names the \`authorization_endpoint\`, \`token_endpoint\`, the DCR
  \`registration_endpoint\`, supported grant types, and PKCE methods.
- **Protected-resource metadata (RFC 9728):**
  \`${protectedResourceMetadataPath}\`
  Per-workspace. Names the resource audience and which authorization server
  can issue tokens for it. The standard MCP bootstrap is: hit the resource
  URL, get a \`401\` carrying a \`WWW-Authenticate\` resource-metadata
  pointer, fetch this document, then redirect to the authorization server's
  \`authorize\` endpoint.

## Scopes

Request the scopes you need at registration:

${scopeLines}

## Self-serve: provision a trial workspace

If you have no account, workspace, or bearer yet, provision one with the
\`start_trial\` tool. It lives on the **unauthenticated onboarding MCP
endpoint** at:

\`\`\`
${onboardingPath}
\`\`\`

\`start_trial\` is the only capability that endpoint exposes — it cannot
query data or bind an actor. Call it with:

- \`email\` — a business email for the new account.
- \`orgName\` — a name for the new workspace.
- \`turnstileToken\` — a Cloudflare Turnstile token proving the signup is
  human-initiated. Required.

On success it returns:

- \`workspaceId\` — the id of the freshly created workspace.
- \`connectUrl\` — the hosted-MCP connect URL to attach your agent to.
- \`state\` — \`grace\` while the account is unclaimed, or \`locked\` if the
  email already consumed a trial.

\`start_trial\` is abuse-controlled: signups are rate-limited per IP and per
email, and a missing or invalid Turnstile token is rejected. Surface those
failures to the user rather than retrying blindly.

## Connect: DCR + PKCE against the connect URL

Once you have a \`connectUrl\`, run the standard connect flow against it:

1. Point your MCP client at the \`connectUrl\`. It returns \`401\` with the
   RFC 9728 resource-metadata pointer.
2. Fetch the protected-resource metadata, then the authorization-server
   metadata, to discover the endpoints.
3. Register your client with **Dynamic Client Registration** at the
   \`registration_endpoint\`.
4. Run the **authorization-code flow with PKCE** to obtain a token carrying
   at least the \`mcp:read\` scope, bound to the MCP resource audience.
5. Attach as a hosted actor and use the MCP tools.

Only the authorization-code + PKCE path is supported.
\`client_credentials\` (machine-to-machine) connect is not.

## Hand off to the human to start the full trial

A trial provisioned through \`start_trial\` begins **unclaimed**, in a short
grace window. To start the full 14-day trial, the human must **claim the
account on the web** — surface that next step to your user after connecting.
Until they claim it, the workspace stays in the grace window and is subject
to the trial's economic limits.

## Go deeper

For the complete integration guide, see the Atlas documentation:

${docsUrl}

---

*Future direction: Atlas may later support provider-attested, agent-verified
registration. That flow is not implemented today and this document
describes no endpoint for it — agents should use the DCR + PKCE +
\`start_trial\` path above.*
`;
}
