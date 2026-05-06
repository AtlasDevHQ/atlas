/**
 * Real OAuth 2.1 round-trip helper for the canonical-question MCP eval (#2119).
 *
 * Phase 1 (#2074, PR #2120) deliberately mocked `verifyAccessToken` at the
 * test boundary so the eval did not need a real auth server. That made
 * Phase 1 cheap to run in CI but it skipped the JWKS path entirely — a
 * regression like "JWT signature verification subtly broken under load"
 * could ship green.
 *
 * This module closes that gap. We boot a self-contained Better Auth
 * instance with the same `jwt()` + `oauthProvider()` plugins production
 * uses (against an in-memory adapter), provision a test user + workspace,
 * drive the real OAuth 2.1 loopback flow via {@link runHostedAuthFlow}'s
 * test seams, and return a real JWT signed by the in-process JWKS. The
 * MCP route's bearer middleware verifies that JWT through the same JWKS
 * endpoint — no mock — so a regression in any of:
 *
 *   - JWKS publication / serialization
 *   - JWT signature verification
 *   - audience / issuer matching against the resolved request origin
 *   - workspace-claim stamping
 *
 * fails this eval before it ships.
 *
 * ── What this module is NOT ─────────────────────────────────────────
 *
 * - It does NOT boot the full Atlas API (`buildAppLayer`). The Layer DAG
 *   pulls in Postgres migrations, semantic sync, the scheduler, and OTel
 *   — none of which are load-bearing for the OAuth path. We mount Better
 *   Auth directly on a Hono app sitting next to the MCP router.
 * - It does NOT exercise platform admin / SCIM / Stripe / two-factor /
 *   passkey plugins. The production `buildPlugins()` includes those for
 *   schema reasons unrelated to OAuth; the eval pares the plugin set down
 *   to the OAuth surface.
 *
 * ── Resource-indicator workaround ────────────────────────────────────
 *
 * `@better-auth/oauth-provider` only issues JWT-formatted access tokens
 * when the token request carries a `resource` parameter (RFC 8707). The
 * upstream `runHostedAuthFlow` in `@useatlas/mcp/init` does not include
 * `resource` today (tracked separately as #2124 — Gap 1). For the eval
 * we wrap the test seam's `fetchImpl` to inject `resource=${apiUrl}/mcp`
 * into the token-exchange POST body so the issued token is JWT-formatted
 * and carries the `aud` claim the MCP route's verifier requires. Once
 * #2124 lands the `fetchImpl` body-patch can be removed.
 */

import { betterAuth } from "better-auth";
import { bearer, jwt, organization } from "better-auth/plugins";
import { memoryAdapter } from "better-auth/adapters/memory";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Hono } from "hono";
import type { Server } from "bun";
import type { betterAuth as betterAuthFn } from "better-auth";

// Untyped alias around `ReturnType<typeof betterAuth>`. Better Auth's
// return type is generic over the precise `BetterAuthOptions` shape it
// receives — pinning it to a specific options literal causes
// `Auth<{secret, baseURL, ...}>` and `Auth<BetterAuthOptions>` to be
// unassignable. The eval doesn't care about the option-graph specifics
// at the public API boundary; what matters is that `auth.handler` and
// `auth.api.*` are callable, which the workspace-typed cast provides.
type EvalAuth = ReturnType<typeof betterAuthFn>;
// `auth.api` is keyed by the union of every plugin's endpoint shape.
// We invoke `signUpEmail` / `createOrganization` / `setActiveOrganization`
// through this cast so a future plugin upgrade that renames any one of
// them surfaces at runtime ("function is not a function") rather than
// silently no-oping; the runtime shape is stable across the 1.6.x line.
interface EvalAuthApi {
  signUpEmail: (input: {
    body: { email: string; password: string; name: string };
    asResponse: true;
  }) => Promise<Response>;
  createOrganization: (input: {
    body: { name: string; slug: string };
    headers: Headers;
  }) => Promise<{ id?: string } | null>;
  setActiveOrganization: (input: {
    body: { organizationId: string };
    headers: Headers;
  }) => Promise<unknown>;
}
import {
  runHostedAuthFlow,
  type Bearer,
  type HostedFlowOptions,
  type HostedFlowResult,
  type LoopbackHandler,
  type LoopbackServer,
  type ServeImpl,
  type OpenBrowserImpl,
} from "@useatlas/mcp/init";
import { ATLAS_OAUTH_WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Bound auth fixture: the Better Auth instance, the Bun.serve handle that
 * hosts both the auth surface and the MCP router, the credentials of the
 * provisioned user + workspace, and the issued bearer JWT.
 *
 * `close()` shuts the server cleanly; callers MUST run it in a `finally`
 * so a failed `beforeAll` does not leave a port bound.
 */
export interface EvalAuthFixture {
  readonly server: Server<unknown>;
  readonly baseUrl: string;
  readonly bearer: string;
  readonly workspaceId: string;
  readonly mcpUrl: string;
  readonly userId: string;
  readonly close: () => void;
}

export interface EvalAuthOptions {
  /** Hono app that mounts /mcp/{workspace_id}/sse — supplied by the eval. */
  readonly mcpRouter: Hono;
  /** Email for the provisioned admin. Defaults to `eval@atlas.test`. */
  readonly userEmail?: string;
  /** Password for the provisioned admin. Defaults to a fixed value. */
  readonly userPassword?: string;
  /** Workspace slug for the provisioned organization. Defaults to `eval`. */
  readonly workspaceSlug?: string;
  /** Workspace name for the provisioned organization. */
  readonly workspaceName?: string;
}

const DEFAULT_USER_EMAIL = "eval@atlas.test";
const DEFAULT_USER_PASSWORD = "atlas-eval-pw-1234";
const DEFAULT_WORKSPACE_SLUG = "eval";
const DEFAULT_WORKSPACE_NAME = "Eval Workspace";
const DEFAULT_USER_NAME = "Eval Admin";
const REQUESTED_SCOPE_LIST = ["openid", "profile", "email", "mcp:read", "offline_access"] as const;

/**
 * Boot a self-contained Better Auth + MCP server, provision a test user +
 * organization, run the real OAuth 2.1 loopback flow, and return the
 * issued bearer.
 *
 * The returned `bearer` is a real JWT signed by the in-process JWKS — the
 * MCP route's `verifyAccessToken` resolves the same JWKS endpoint and
 * verifies the signature for real.
 */
export async function startEvalAuthServer(
  options: EvalAuthOptions,
): Promise<EvalAuthFixture> {
  // Step 0 — clear the env vars that the MCP route's bearer middleware
  // reads to resolve audience + issuer + JWKS URL. Both `.env` and CI may
  // set `BETTER_AUTH_URL` / `ATLAS_PUBLIC_API_URL` to the dev API host
  // (`http://localhost:3001`) — the route would then look up audience
  // there instead of at the in-process test port, and every dispatch
  // would fail with `invalid_bearer`. Restore on close so tests in the
  // same process that read these vars later see the original values.
  const previousPublicApiUrl = process.env.ATLAS_PUBLIC_API_URL;
  const previousBetterAuthUrl = process.env.BETTER_AUTH_URL;
  delete process.env.ATLAS_PUBLIC_API_URL;
  delete process.env.BETTER_AUTH_URL;
  const restoreEnv = () => {
    if (previousPublicApiUrl === undefined) delete process.env.ATLAS_PUBLIC_API_URL;
    else process.env.ATLAS_PUBLIC_API_URL = previousPublicApiUrl;
    if (previousBetterAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previousBetterAuthUrl;
  };

  // Step 1 — bind a TCP port up front. The auth instance's `validAudiences`
  // must include `${baseUrl}/mcp`, but we only know `baseUrl` after
  // `Bun.serve` picks a port. The placeholder fetch closes over a mutable
  // reference to the real handler, which we install once the auth + router
  // are constructed against the resolved baseUrl.
  let resolvedFetch: ((req: Request) => Response | Promise<Response>) | null = null;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (req) =>
      resolvedFetch
        ? resolvedFetch(req)
        : new Response("eval auth server not yet wired", { status: 503 }),
  });
  if (typeof server.port !== "number") {
    server.stop(true);
    throw new Error("Bun.serve did not bind a TCP port for eval auth");
  }
  const baseUrl = `http://localhost:${server.port}`;

  try {
    const auth = buildEvalAuth({ baseUrl });

    // Step 2 — assemble the Hono app: Better Auth handler at /api/auth/*,
    // OAuth discovery at /.well-known/oauth-authorization-server/api/auth
    // (matches the upstream MCP CLI's discovery URL), and the supplied
    // MCP router at /mcp/*. Discovery serves Better Auth's own metadata
    // helper directly — no Atlas wrapper, no managed-mode gating.
    const app = new Hono();
    app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
    app.get("/.well-known/oauth-authorization-server/api/auth", async (c) => {
      const { oauthProviderAuthServerMetadata } = await import("@better-auth/oauth-provider");
      const handler = oauthProviderAuthServerMetadata(
        auth as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0],
      );
      return handler(c.req.raw);
    });
    app.route("/mcp", options.mcpRouter);
    resolvedFetch = app.fetch;

    // Step 3 — provision the admin user, workspace, and an active session.
    // The session cookie carries `activeOrganizationId`, which the
    // `clientReference` callback in `oauthProvider` reads to stamp the
    // workspace_id claim onto the issued JWT. No active workspace =
    // missing_workspace_claim at the MCP edge.
    const provisioned = await provisionTestUser({
      auth,
      email: options.userEmail ?? DEFAULT_USER_EMAIL,
      password: options.userPassword ?? DEFAULT_USER_PASSWORD,
      name: DEFAULT_USER_NAME,
      workspaceName: options.workspaceName ?? DEFAULT_WORKSPACE_NAME,
      workspaceSlug: options.workspaceSlug ?? DEFAULT_WORKSPACE_SLUG,
    });

    // Step 4 — drive the real loopback OAuth flow. The bearer that comes
    // out is a real JWT verified against the in-process JWKS by the MCP
    // route on every request.
    const flow = await runEvalAuthFlow({
      apiUrl: baseUrl,
      app,
      sessionCookie: provisioned.sessionCookie,
    });

    if (flow.workspaceId !== provisioned.workspaceId) {
      throw new Error(
        `OAuth workspace mismatch — token claims ${flow.workspaceId}, expected ${provisioned.workspaceId}. ` +
          `Likely a misconfigured customAccessTokenClaims hook.`,
      );
    }

    return {
      server,
      baseUrl,
      bearer: flow.accessToken,
      workspaceId: flow.workspaceId,
      mcpUrl: flow.mcpUrl,
      userId: provisioned.userId,
      close: () => {
        server.stop(true);
        restoreEnv();
      },
    };
  } catch (err) {
    server.stop(true);
    restoreEnv();
    throw err;
  }
}

// ── Better Auth instance ────────────────────────────────────────────

interface BuildEvalAuthOptions {
  readonly baseUrl: string;
}

/**
 * Construct the Better Auth instance the eval mounts. The plugin set is
 * pared down to the OAuth surface — `bearer`, `jwt`, `organization`, and
 * `oauthProvider` — so the in-memory adapter does not have to migrate
 * SCIM / Stripe / two-factor / passkey schemas the eval never exercises.
 *
 * The `oauthProvider` config mirrors production:
 *
 *   - `clientReference` reads `session.activeOrganizationId` so issued
 *     tokens carry the same `referenceId` semantics production uses.
 *   - `customAccessTokenClaims` stamps the URN-shaped workspace claim
 *     identical to `packages/api/src/lib/auth/server.ts`. The MCP route
 *     reads this same claim back at the verifier boundary.
 *   - `validAudiences` includes `${baseUrl}/mcp` — matches what the MCP
 *     route's `resourceAudience(req)` builds from the request origin.
 *   - DCR is unauthenticated (`allowUnauthenticatedClientRegistration`)
 *     so the test seam can register a public client without a prior
 *     credential, the same way Claude Desktop does in production.
 */
function buildEvalAuth(opts: BuildEvalAuthOptions): EvalAuth {
  // Cast at the boundary: `betterAuth(...)` returns `Auth<<inferred
  // tuple>>`, which is structurally narrower than the declared
  // `Auth<BetterAuthOptions>` return type because TS can't widen the
  // option-graph generic across the plugin tuple. We pay the type cost
  // here once so callers see a uniform `EvalAuth` and don't have to
  // know the option-graph specifics. The cast is safe because every
  // surface we touch (`auth.handler`, `auth.api.*`) is part of the
  // base shape, not the option-graph projection.
  return betterAuth({
    secret: "atlas-eval-test-secret-not-for-production-use-32+chars",
    baseURL: opts.baseUrl,
    // Memory adapter requires every table the plugin set will touch to
    // be pre-allocated as an empty array, otherwise the first findOne
    // throws "Model X not found". The plugin set below exercises:
    //   - core:           user, account, session, verification
    //   - organization:   organization, member, invitation, team,
    //                     teamMember
    //   - jwt:            jwks
    //   - oauth-provider: oauthClient, oauthAccessToken,
    //                     oauthRefreshToken, oauthConsent
    // Listing them inline (rather than auto-discovering from the plugin
    // schema) keeps the eval failure mode obvious — a future plugin
    // upgrade that adds a new table will surface as "Model Z not found"
    // on the first request, which is a more actionable signal than
    // silent corruption.
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
      team: [],
      teamMember: [],
      jwks: [],
      oauthClient: [],
      oauthAccessToken: [],
      oauthRefreshToken: [],
      oauthConsent: [],
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    plugins: [
      bearer(),
      organization({
        // Members can create the org; defaults are fine — no custom
        // permissions matrix is required for the OAuth path.
      }),
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth2/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: [...REQUESTED_SCOPE_LIST],
        validAudiences: [`${opts.baseUrl}/mcp`],
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 60 * 60 * 24,
        clientReference: ({ session }) => {
          // The cast mirrors `packages/api/src/lib/auth/server.ts` —
          // Better Auth's session-organization extension is contributed
          // by the organization plugin and is not part of the base
          // session type the oauthProvider sees.
          const orgId = (session as { activeOrganizationId?: string | null } | null | undefined)
            ?.activeOrganizationId;
          return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
        },
        // `postLogin.consentReferenceId` is the hook that propagates
        // the workspace id onto issued tokens — `clientReference`
        // above only governs DCR client ownership. Mirrors the
        // production config in `packages/api/src/lib/auth/server.ts`;
        // the parity is what makes the eval a valid regression test
        // for the production OAuth path.
        postLogin: {
          page: "/oauth2/post-login",
          consentReferenceId: async ({ session }) => {
            const orgId = (session as { activeOrganizationId?: string | null } | null | undefined)
              ?.activeOrganizationId;
            return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
          },
          // No interstitial — the eval has a single-org fixture so
          // workspace selection is deterministic.
          shouldRedirect: () => false,
        },
        customAccessTokenClaims: ({ referenceId }) => {
          return referenceId
            ? { [ATLAS_OAUTH_WORKSPACE_CLAIM]: referenceId }
            : {};
        },
      }),
    ],
  }) as unknown as EvalAuth;
}

// ── Programmatic user + workspace provisioning ──────────────────────

interface ProvisionInput {
  readonly auth: EvalAuth;
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
}

interface ProvisionResult {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionCookie: string;
}

/**
 * Sign up the admin user, create their organization, and set it active —
 * all via Better Auth's programmatic `auth.api.*` surface (no HTTP). The
 * session cookie returned is what the OAuth-authorize handler reads to
 * resolve `activeOrganizationId`; without it, the issued token would
 * carry no workspace claim and the MCP route would 401.
 */
async function provisionTestUser(input: ProvisionInput): Promise<ProvisionResult> {
  // Cast through `unknown` because Better Auth's `api` shape is an
  // intersection over every plugin's endpoint surface and TS cannot
  // narrow it across the eval's plugin-tuple erasure. `EvalAuthApi`
  // lists exactly the three calls we make so a runtime drift surfaces
  // as a TypeError on the next test run, not a silent no-op.
  const api = input.auth.api as unknown as EvalAuthApi;

  // `signUpEmail` with `autoSignIn: true` returns both a user and a
  // session cookie via `Set-Cookie`. We need the cookie to carry through
  // organization creation + activation, so we read it from the response.
  const signUpResp = await api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
    },
    asResponse: true,
  });
  const initialCookie = signUpResp.headers.get("set-cookie");
  if (!initialCookie) {
    throw new Error("signUpEmail did not return a Set-Cookie header — autoSignIn may be off");
  }
  const cookieValue = parseSetCookie(initialCookie);
  const signUpBody = (await signUpResp.json().catch(() => null)) as { user?: { id?: unknown } } | null;
  const userId = signUpBody?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("signUpEmail response missing user.id");
  }

  // Create the organization; the response carries the org id we need to
  // activate. Header-driven session: rather than threading the cookie
  // through every call site, we spread it onto a Headers object the
  // organization endpoint accepts.
  const sessionHeaders = new Headers({ Cookie: cookieValue });
  const created = await api.createOrganization({
    body: {
      name: input.workspaceName,
      slug: input.workspaceSlug,
    },
    headers: sessionHeaders,
  });
  const workspaceId = created?.id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("createOrganization did not return an id");
  }

  // Activate the workspace on the session — the `clientReference`
  // callback reads `session.activeOrganizationId` at authorize time.
  await api.setActiveOrganization({
    body: { organizationId: workspaceId },
    headers: sessionHeaders,
  });

  return { userId, workspaceId, sessionCookie: cookieValue };
}

/**
 * Extract the cookie name=value pair from a `Set-Cookie` header,
 * dropping attributes the client doesn't echo back (Path / HttpOnly /
 * SameSite / Max-Age / Expires). We only need the cookie itself for
 * subsequent in-process calls — nothing reads the attributes here.
 */
function parseSetCookie(setCookie: string): string {
  return setCookie.split(",").map((entry) => entry.split(";")[0]?.trim() ?? "").filter(Boolean).join("; ");
}

// ── Loopback OAuth driver ───────────────────────────────────────────

interface RunFlowInput {
  readonly apiUrl: string;
  readonly app: Hono;
  readonly sessionCookie: string;
}

/**
 * Drive `runHostedAuthFlow` against the in-process server.
 *
 * The seams:
 *
 *   - `fetchImpl` — dispatches discovery, DCR, and the token exchange
 *     directly through `app.fetch`. We also inject `resource=${apiUrl}/mcp`
 *     into the token-exchange body so Better Auth issues a JWT (RFC 8707
 *     workaround for #2124).
 *   - `serveImpl` — captures the loopback handler. The "browser" calls it
 *     directly with the redirect params; no real port is bound.
 *   - `openBrowserImpl` — drives the authorize endpoint with the session
 *     cookie, posts auto-consent if Better Auth redirects to the consent
 *     page, then invokes the captured loopback handler with the final
 *     `code` + `state` from the redirect URL.
 */
async function runEvalAuthFlow(input: RunFlowInput): Promise<HostedFlowResult> {
  const resourceIndicator = `${input.apiUrl.replace(/\/+$/, "")}/mcp`;

  // ── fetchImpl ────────────────────────────────────────────────────
  const fetchImpl: typeof fetch = (async (
    rawInput: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(typeof rawInput === "string" || rawInput instanceof URL ? new URL(rawInput).toString() : rawInput.url, init);
    // Thread the test session cookie onto every auth-server request the
    // flow makes. DCR specifically needs it: `oauthProvider.clientReference`
    // only fires when DCR sees a session, which is what stamps the
    // `referenceId` (workspace id) onto the registered client. Without
    // it, the issued token carries no workspace claim and the MCP edge
    // 401s with `missing_workspace_claim`. Production MCP clients
    // (Claude Desktop / Cursor) get this for free because DCR runs
    // inside the user's authenticated browser session; the upstream
    // CLI flow at `@useatlas/mcp/init` does not pass cookies, which is
    // why production tokens issued via the CLI alone wouldn't carry
    // the claim either (tracked separately as #2124).
    const headersWithCookie = new Headers(req.headers);
    if (!headersWithCookie.has("Cookie")) {
      headersWithCookie.set("Cookie", input.sessionCookie);
    }
    if (req.method === "POST" && req.url.includes("/oauth2/token")) {
      // Patch the body to include `resource=${resourceIndicator}`.
      // Without this Better Auth issues an opaque token and the MCP
      // route's verifier (which expects JWT) rejects with
      // invalid_bearer. See the module docstring's resource-indicator
      // workaround note for #2124.
      const body = await req.text();
      const params = new URLSearchParams(body);
      if (!params.has("resource")) params.set("resource", resourceIndicator);
      const patched = new Request(req.url, {
        method: req.method,
        headers: headersWithCookie,
        body: params.toString(),
      });
      return input.app.fetch(patched);
    }
    const withCookie = new Request(req.url, {
      method: req.method,
      headers: headersWithCookie,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text().catch(() => ""),
    });
    return input.app.fetch(withCookie);
  }) as unknown as typeof fetch;

  // ── serveImpl ────────────────────────────────────────────────────
  let captured: { handler: LoopbackHandler; port: number } | null = null;
  const serveImpl: ServeImpl = async (handler) => {
    const stub: LoopbackServer = {
      port: 49152,
      stop: async () => {},
    };
    captured = { handler, port: stub.port };
    return stub;
  };

  // ── openBrowserImpl ──────────────────────────────────────────────
  // Drives the authorize endpoint. Better Auth's consent-skip path:
  //   1. GET /api/auth/oauth2/authorize?... → 302 to /oauth2/consent
  //      (the configured consentPage) with `oauth_query` URL param OR
  //      directly to the redirect_uri if a consent record already exists.
  //   2. We POST /api/auth/oauth2/consent with `{ accept: true,
  //      oauth_query: <captured> }` and the session cookie. The endpoint
  //      returns `{ redirect_uri }` (or 200/302; we narrow on shape).
  //   3. Parse `code` + `state` from `redirect_uri` and invoke the
  //      loopback handler directly (no real network).
  //
  // This mirrors what a real browser would do: auto-approve scope, follow
  // the redirect. The session cookie threads through every request — no
  // cookie = anonymous = redirect to /login = test fails fast.
  const openBrowserImpl: OpenBrowserImpl = async (authorizeUrl) => {
    if (!captured) {
      throw new Error("openBrowserImpl invoked before serveImpl captured the handler");
    }
    const sessionHeaders = { Cookie: input.sessionCookie } as const;

    // Step 1 — drive authorize. Manual `redirect: "manual"` so we can
    // capture the `Location` header rather than auto-following it (the
    // redirect target is the consent page, not the auth surface).
    const authorizeReq = new Request(authorizeUrl, {
      method: "GET",
      headers: sessionHeaders,
    });
    const authorizeRes = await input.app.fetch(authorizeReq);
    const location = authorizeRes.headers.get("location");
    if (!location) {
      const status = authorizeRes.status;
      const body = await authorizeRes.text().catch(() => "<unreadable>");
      throw new Error(
        `authorize endpoint did not redirect (status=${status}, body=${body.slice(0, 256)})`,
      );
    }

    // Step 2 — branch on whether Better Auth redirected to the consent
    // page (no prior consent) or directly to the loopback redirect_uri
    // (consent already on record). The first time through is always
    // the consent path; running the same flow twice in one test would
    // hit the second branch.
    let finalRedirect: string;
    if (location.includes("/oauth2/consent")) {
      // Better Auth's authorize handler redirects to the consent page
      // with the FULL ORIGINAL QUERY copied onto the consent URL —
      // not bundled as a single `oauth_query` param. The consent
      // endpoint's body schema names that bundle `oauth_query`, so we
      // extract everything after `?` from the redirect Location and
      // forward it verbatim. A regression that drops a query field
      // (e.g. code_challenge) would surface as a 400 from the consent
      // endpoint, not a silent pass.
      const consentUrl = new URL(location, input.apiUrl);
      const oauthQuery = consentUrl.search.replace(/^\?/, "");
      if (!oauthQuery) {
        throw new Error(
          `authorize redirected to consent but no query string was carried: ${location}`,
        );
      }
      const consentRes = await input.app.fetch(
        new Request(`${input.apiUrl}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: {
            ...sessionHeaders,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
        }),
      );
      if (!consentRes.ok) {
        const body = await consentRes.text().catch(() => "<unreadable>");
        throw new Error(
          `consent endpoint returned ${consentRes.status}: ${body.slice(0, 256)}`,
        );
      }
      const consentBody = (await consentRes.json().catch(() => null)) as
        | { redirect_uri?: unknown; redirectURI?: unknown; url?: unknown; redirect?: unknown }
        | null;
      // Better Auth currently returns `{ redirect: true, url }` — the
      // metadata.openapi block on the consent endpoint advertises
      // `redirect_uri` (older shape), so we accept both for forward
      // compatibility. A future plugin upgrade that renames either is
      // surfaced as the explicit "did not return" error below.
      const redirect =
        typeof consentBody?.url === "string"
          ? consentBody.url
          : typeof consentBody?.redirect_uri === "string"
            ? consentBody.redirect_uri
            : typeof consentBody?.redirectURI === "string"
              ? consentBody.redirectURI
              : null;
      if (redirect === null) {
        throw new Error(
          `consent endpoint did not return a redirect URL (body=${JSON.stringify(consentBody)})`,
        );
      }
      finalRedirect = redirect;
    } else {
      finalRedirect = location;
    }

    // Step 3 — parse code + state from the final redirect and fire the
    // loopback handler. This is the "browser arrived at the loopback
    // URL" moment in production.
    const parsed = new URL(finalRedirect);
    const params = parsed.searchParams;
    if (!params.get("code") || !params.get("state")) {
      throw new Error(
        `final redirect missing code/state: ${finalRedirect}`,
      );
    }
    const result = captured.handler(params, "GET");
    if (result.status !== 200) {
      throw new Error(
        `loopback handler refused callback (status=${result.status}, body=${result.body.slice(0, 256)})`,
      );
    }
    return { ok: true };
  };

  const flowOptions: HostedFlowOptions = {
    apiUrl: input.apiUrl,
    fetchImpl,
    serveImpl,
    openBrowserImpl,
    callbackTimeoutMs: 10_000,
    consoleImpl: { log: () => {}, error: () => {} },
  };

  const result = await runHostedAuthFlow(flowOptions);

  // The bearer brand is just a string; surface a string at the boundary
  // so callers don't have to import the Bearer brand type.
  return {
    accessToken: result.accessToken as Bearer,
    refreshToken: result.refreshToken,
    workspaceId: result.workspaceId,
    mcpUrl: result.mcpUrl,
  };
}
