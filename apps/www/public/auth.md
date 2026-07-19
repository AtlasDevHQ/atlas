# auth.md

**Connecting an agent to Atlas.** This document is for autonomous agents (and
the humans integrating them).
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

- **Authorization server (issuer):** `https://api.useatlas.dev/api/auth`
- **MCP resource server:** `https://mcp.useatlas.dev/mcp`

Tokens you obtain must bind to the resource-server audience exactly as the
protected-resource metadata advertises it.

## Discover the machine-readable metadata

Atlas serves standard discovery documents. Read these to locate the
authorize, token, and DCR registration endpoints — do not hard-code them.

- **Authorization-server metadata (RFC 8414):**
  `https://api.useatlas.dev/.well-known/oauth-authorization-server/api/auth`
  Names the `authorization_endpoint`, `token_endpoint`, the DCR
  `registration_endpoint`, supported grant types, and PKCE methods.
- **Protected-resource metadata (RFC 9728):**
  `/.well-known/oauth-protected-resource/mcp/{workspace_id}`
  Per-workspace. Names the resource audience and which authorization server
  can issue tokens for it. The standard MCP bootstrap is: hit the resource
  URL, get a `401` carrying a `WWW-Authenticate` resource-metadata
  pointer, fetch this document, then redirect to the authorization server's
  `authorize` endpoint.

## Scopes

Request the scopes you need at registration:

- `mcp:read` — query workspace data through the hosted MCP endpoint
- `mcp:write` — perform write operations (reserved for future mutation tools)
- `offline_access` — receive a refresh token so the connection survives access-token expiry

## Self-serve: provision a trial workspace

If you have no account, workspace, or bearer yet, provision one with the
`start_trial` tool. It lives on the **unauthenticated onboarding MCP
endpoint** at:

```
/mcp/onboarding
```

This endpoint speaks the **Streamable HTTP** MCP transport — a single URL that
handles `POST`/`GET`/`DELETE` with an `mcp-session-id` header. It is NOT
the deprecated HTTP+SSE transport, so point a Streamable HTTP client at it (the
legacy `/mcp/onboarding/sse` alias resolves to the same endpoint).

`start_trial` is the only capability that endpoint exposes — it cannot
query data or bind an actor. Call it with:

- `email` — a business email for the new account.
- `orgName` — a name for the new workspace.

That is the whole input — a headless caller needs no browser and no
bot-protection token. (Proof-of-human lives on the interactive web signup, not
on this door.)

On success it returns:

- `workspaceId` — the id of the freshly created workspace.
- `connectUrl` — the hosted-MCP connect URL to attach your agent to.
- `claimUrl` — the web claim interstitial the human opens to verify their
  email, add a passkey, and start the full 14-day trial.
- `state` — `grace` while the account is unclaimed, or `locked` if the
  email already consumed a trial.

`start_trial` is abuse-controlled: signups are rate-limited per IP and per
email, personal/disposable addresses are rejected, and an unclaimed trial is
reaped after a short grace window. Surface those failures to the user rather
than retrying blindly.

## Connect: DCR + PKCE against the connect URL

Once you have a `connectUrl`, run the standard connect flow against it:

1. Point your MCP client at the `connectUrl`. It returns `401` with the
   RFC 9728 resource-metadata pointer.
2. Fetch the protected-resource metadata, then the authorization-server
   metadata, to discover the endpoints.
3. Register your client with **Dynamic Client Registration** at the
   `registration_endpoint`.
4. Run the **authorization-code flow with PKCE** to obtain a token carrying
   at least the `mcp:read` scope, bound to the MCP resource audience.
5. Attach as a hosted actor and use the MCP tools.

Only the authorization-code + PKCE path is supported.
`client_credentials` (machine-to-machine) connect is not.

## Hand off to the human to start the full trial

A trial provisioned through `start_trial` begins **unclaimed**, in a short
grace window. To start the full 14-day trial, the human opens the **claim
interstitial** on the web (the `claimUrl` in the `start_trial` result):
they verify their email and **add a passkey** in one step — surface that next
step to your user after connecting. Until they claim it, the workspace stays
in the grace window and is subject to the trial's economic limits.

## Member vs admin actions: the second-factor posture

A workspace's programmatic surface has two floors, and they differ only in
whether a second factor is required:

- **Member-floor data actions** — `query`, `executeSQL`/`sql`, `explore`,
  `runMetric`, and `profile_datasource` — need only an authenticated
  principal: your hosted OAuth actor, or a workspace API key. **No second
  factor.** A member's programmatic reach equals their in-app agent reach,
  bounded by SQL validation, the table whitelist, RLS, and approval rules.
- **Admin-floor config actions** — creating or publishing a datasource,
  minting a workspace API key, and other governance changes — require an
  **MFA-enrolled managed session** (the workspace `admin`/`owner` role with a
  second factor on file). This is a deliberate compliance commitment, **not**
  relaxed for trials. Hitting it unenrolled returns `mfa_enrollment_required`
  — that is actionable guidance, not a bug, so surface it rather than retrying.

**Establish the strong factor once, then run unattended.** The claim
interstitial **enrolls a passkey as part of claiming** (nothing to type or
remember), and that passkey doubles as the admin second factor, so a
freshly-claimed owner reaches admin actions with no extra setup. (On a browser
without passkey support, the interstitial falls back to emailing a link to set a
sign-in credential, after which the human enrolls an authenticator app under
**Account → Security**; either factor can also be managed there later.) With a
factor on file, admin actions succeed. For CI and unattended agents, the human
then mints a **workspace API key**: it is owner-attributed, carries member- or
admin-scope,
and is itself **exempt from the second-factor check** (its lifetime control is
key expiry, not an interactive factor). This is the GitHub personal-access-token
/ Stripe restricted-key model — one interactive browser bootstrap, then a scoped
key for everything automated.

## Go deeper

For the complete integration guide, see the Atlas documentation:

https://docs.useatlas.dev

---

*Future direction: Atlas may later support provider-attested, agent-verified
registration. That flow is not implemented today and this document
describes no endpoint for it — agents should use the DCR + PKCE +
`start_trial` path above.*
