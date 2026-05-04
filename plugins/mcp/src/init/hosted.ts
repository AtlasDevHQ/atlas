/**
 * `init --hosted` flow: OAuth 2.1 authorization-code-with-PKCE against the
 * hosted Atlas MCP endpoint (#2024 PR E).
 *
 * ── Why loopback (RFC 8252) over device code (RFC 8628) ────────────────
 *
 * The MCP authorization spec requires an OAuth 2.1 server (PR C wired
 * `@better-auth/oauth-provider` for that). Standards-compliant native MCP
 * clients (Claude Desktop, Cursor, ChatGPT) already use the loopback flow
 * — same shape as `gh auth login` and `gcloud auth login`. RFC 8252 §7.3
 * recommends loopback for any native client that can spawn a browser:
 * better UX than reading codes off a screen, no polling, no
 * pre-registered client_id needed when DCR is available.
 *
 * The loopback redirect MUST use `127.0.0.1` (not `localhost`) per RFC
 * 8252 §7.3 — DNS resolution to `localhost` is implementation-defined and
 * a hostile resolver could redirect the auth code somewhere else.
 *
 * ── Why DCR is unauthenticated ─────────────────────────────────────────
 *
 * The auth server is configured with `allowUnauthenticatedClientRegistration: true`
 * in `packages/api/src/lib/auth/server.ts`. Without it an MCP client
 * couldn't bootstrap — there's no admin pre-issuing a client_id for every
 * end-user's machine. The MCP spec is on track to standardize Client ID
 * Metadata Documents which would let us turn this off; track upstream.
 *
 * ── What we DON'T persist ──────────────────────────────────────────────
 *
 * The PKCE `code_verifier` and the registered `client_id` are kept in
 * memory for the duration of the flow only — never written to disk. The
 * only artifact written is the JWT access token (and optional refresh
 * token), inside the user's MCP client config file at mode 0o600.
 *
 * ── Test seams ─────────────────────────────────────────────────────────
 *
 * Every external dependency is overrideable so the unit tests in
 * `__tests__/init/hosted.test.ts` never open a browser, never bind a real
 * port, and never hit a real OAuth server.
 *
 *   - `fetchImpl`            — discovery, DCR, token exchange
 *   - `openBrowserImpl`      — browser launch (returns success/failure)
 *   - `serveImpl`            — loopback listener factory
 *   - `randomBytesImpl`      — PKCE verifier + state (deterministic asserts)
 *   - `nowImpl`              — for the 5-minute timeout
 *   - `consoleImpl`          — captures user-facing output
 */

// ── External shape contracts (test seams) ──────────────────────────────

export interface LoopbackServer {
  /** Bound port — the OS picked it when we requested 0. */
  readonly port: number;
  /** Stop accepting and drain. Called on success, timeout, or error. */
  stop(): Promise<void>;
}

/**
 * Loopback handler return value. Status is narrowed to the two values
 * the OAuth callback ever produces — 200 on success, 400 on protocol
 * failures (state mismatch, missing code, oauth error). The body is HTML
 * so any `ServeImpl` substituting for the default `Bun.serve` backend
 * MUST set `Content-Type: text/html; charset=utf-8` on the response.
 */
export interface LoopbackHandler {
  (params: URLSearchParams, method: string): { status: 200 | 400 | 405; body: string };
}

export interface ServeImpl {
  (handler: LoopbackHandler): Promise<LoopbackServer>;
}

export interface OpenBrowserResult {
  ok: boolean;
  /** Human-readable detail shown when ok=false. */
  detail?: string;
}

export interface OpenBrowserImpl {
  (url: string): Promise<OpenBrowserResult>;
}

export interface ConsoleImpl {
  log(message: string): void;
  error(message: string): void;
}

// ── Public types ───────────────────────────────────────────────────────

export interface HostedFlowOptions {
  /**
   * Atlas API base — e.g. `https://api.useatlas.dev`. The discovery doc
   * lives at `${apiUrl}/.well-known/oauth-authorization-server/api/auth`.
   * Must be `https://`, except for `http://127.0.0.1` / `http://localhost`
   * which are accepted for local-dev testing.
   */
  apiUrl: string;
  /** Default 5 min; smaller values shorten test runtime. */
  callbackTimeoutMs?: number;
  /** Test seams — defaults wired to real implementations. */
  fetchImpl?: typeof fetch;
  serveImpl?: ServeImpl;
  openBrowserImpl?: OpenBrowserImpl;
  randomBytesImpl?: (length: number) => Uint8Array;
  consoleImpl?: ConsoleImpl;
}

/**
 * Branded `string` for OAuth bearer credentials. The brand carries no
 * runtime cost; its purpose is to surface bearer-handling code in code
 * review (`accessToken: Bearer` next to a `console.log` is a smell) and
 * to keep the secret-vs-non-secret distinction visible in the type, not
 * just in trailing comments.
 */
export type Bearer = string & { readonly __brand: "Bearer" };

export interface HostedFlowResult {
  /** OAuth 2.1 access token (signed JWT). Treat as a credential. */
  accessToken: Bearer;
  /** OAuth 2.1 refresh token (when offline_access was granted). */
  refreshToken: Bearer | null;
  /** The `https://atlas.useatlas.dev/workspace_id` claim from the JWT. */
  workspaceId: string;
  /** `${apiUrl}/mcp/${workspaceId}/sse` — what the MCP client connects to. */
  mcpUrl: string;
}

// ── OAuth 2.1 metadata + DCR shapes ────────────────────────────────────
//
// Restricted to fields we actually consume. Better Auth's discovery doc
// includes more (e.g. `userinfo_endpoint`, `revocation_endpoint`) but
// nothing else is load-bearing for the loopback flow.

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  issuer: string;
}

interface RegistrationResponse {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class HostedFlowError extends Error {
  constructor(
    message: string,
    /** Stable error code for tests + exit-code mapping. */
    public readonly code:
      | "invalid_api_url"
      | "discovery_failed"
      | "issuer_mismatch"
      | "registration_failed"
      | "loopback_bind_failed"
      | "browser_failed"
      | "callback_timeout"
      | "callback_state_mismatch"
      | "callback_missing_code"
      | "callback_oauth_error"
      | "callback_method_not_allowed"
      | "token_exchange_failed"
      | "missing_workspace_claim",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostedFlowError";
  }
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const REQUESTED_SCOPE = "openid profile email mcp:read offline_access";
const CLIENT_NAME = "Atlas MCP CLI";
const WORKSPACE_CLAIM = "https://atlas.useatlas.dev/workspace_id";

// ── Public entry point ─────────────────────────────────────────────────

/**
 * Run the OAuth 2.1 loopback flow against `apiUrl` and return the minted
 * JWT. Pure data — the caller decides whether to print or write.
 *
 * Cleanup: the loopback listener is stopped in a `finally` so a failed
 * exchange never leaves an orphan port bound. Browser-launch failures
 * fall back to printing the URL and continue waiting for the callback.
 */
export async function runHostedAuthFlow(
  options: HostedFlowOptions,
): Promise<HostedFlowResult> {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  validateApiUrl(apiUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const serveImpl = options.serveImpl ?? defaultServeImpl;
  const openBrowserImpl = options.openBrowserImpl ?? defaultOpenBrowserImpl;
  const randomBytes = options.randomBytesImpl ?? defaultRandomBytes;
  const cli: ConsoleImpl = options.consoleImpl ?? {
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
  const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Step 1 — discovery
  const metadata = await discover(apiUrl, fetchImpl);

  // Step 2 — generate PKCE + state and start the loopback listener BEFORE
  // registering, so we know the redirect_uri the OS picked. RFC 8252
  // §7.3 says clients SHOULD bind to 127.0.0.1 with port 0 and use
  // whatever port they get back.
  const state = encodeBase64Url(randomBytes(32));
  const codeVerifier = encodeBase64Url(randomBytes(32));
  const codeChallenge = await pkceChallenge(codeVerifier);

  const callbackResolver = createCallbackResolver(state, timeoutMs);
  // Defuse unhandled-rejection warnings on the abort path: we cancel the
  // resolver in `finally`, which calls `reject()`. If the outer flow
  // already rejected via a different error, that rejection is orphaned.
  // Attach a no-op catch so it never propagates as unhandled.
  callbackResolver.promise.catch(() => {});

  let server: LoopbackServer | undefined;
  try {
    server = await serveImpl(callbackResolver.handler);
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;

    // Step 3 — register a public client via DCR
    const clientId = await register(metadata, redirectUri, fetchImpl);

    // Step 4 — open the browser. Failure is non-fatal: print the URL
    // (already printed before the launch attempt) and continue waiting.
    // In headless / CI shells the user will hit `callback_timeout`
    // instead — the message there links back to the printed URL above.
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId,
      redirectUri,
      state,
      codeChallenge,
    });
    cli.log(`Opening your browser to authorize Atlas MCP CLI…`);
    cli.log(`If it doesn't open automatically, visit:`);
    cli.log(`  ${authorizeUrl}`);
    const openResult = await openBrowserImpl(authorizeUrl);
    if (!openResult.ok) {
      cli.error(
        `[atlas-mcp init] Could not auto-launch the browser${openResult.detail ? ` (${openResult.detail})` : ""}. Open the URL above manually.`,
      );
    }

    // Step 5 — wait for the callback
    const code = await callbackResolver.promise;

    // Step 6 — exchange the code
    const tokenResponse = await exchangeCode({
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      redirectUri,
      code,
      codeVerifier,
      fetchImpl,
    });

    // Step 7 — extract + verify claims. We don't verify the JWT
    // signature (the hosted MCP endpoint re-verifies on every request via
    // JWKS) but we DO check `iss` matches the issuer we discovered, so a
    // hostile auth server pretending to be Atlas can't slip a token past
    // us at write-time.
    const claims = decodeJwtPayload(tokenResponse.access_token);
    enforceIssuer(claims, metadata.issuer);
    const workspaceId = extractWorkspaceClaim(claims);

    return {
      accessToken: tokenResponse.access_token as Bearer,
      refreshToken: tokenResponse.refresh_token
        ? (tokenResponse.refresh_token as Bearer)
        : null,
      workspaceId,
      mcpUrl: `${apiUrl}/mcp/${workspaceId}/sse`,
    };
  } finally {
    // Cancel the timer FIRST so a 5-min hang can't survive an early
    // failure in `register`/`exchangeCode`/`extractWorkspaceClaim`. Then
    // tear down the listener.
    callbackResolver.cancel();
    if (server) {
      await server.stop().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        cli.error(`[atlas-mcp init] loopback listener cleanup warning: ${msg}`);
      });
    }
  }
}

/**
 * `apiUrl` ends up driving discovery, the redirect target, and the
 * eventual MCP URL written to disk. A typo'd or hostile env var
 * (`ATLAS_PUBLIC_API_URL=http://evil.example.com`) would drive the user
 * through a fake authorize page and ship a foreign-issued JWT into their
 * MCP client config. Reject anything that isn't `https://`, except for
 * documented localhost dev URLs.
 */
function validateApiUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch (err) {
    throw new HostedFlowError(
      `--api-url is not a valid URL: ${apiUrl}`,
      "invalid_api_url",
      { cause: err },
    );
  }
  if (parsed.protocol === "https:") return;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  ) {
    return;
  }
  throw new HostedFlowError(
    `--api-url must use https:// (or http://localhost for dev). Got: ${apiUrl}`,
    "invalid_api_url",
  );
}

// ── Step implementations ───────────────────────────────────────────────

async function discover(
  apiUrl: string,
  fetchImpl: typeof fetch,
): Promise<AuthServerMetadata> {
  const url = `${apiUrl}/.well-known/oauth-authorization-server/api/auth`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HostedFlowError(
      `Could not reach Atlas auth discovery at ${url}: ${msg}`,
      "discovery_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new HostedFlowError(
      `Atlas auth discovery returned ${res.status} for ${url}`,
      "discovery_failed",
    );
  }
  const body = (await res.json().catch((err) => {
    throw new HostedFlowError(
      `Atlas auth discovery body was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "discovery_failed",
      { cause: err },
    );
  })) as Partial<AuthServerMetadata>;
  if (
    typeof body.authorization_endpoint !== "string" ||
    typeof body.token_endpoint !== "string" ||
    typeof body.registration_endpoint !== "string" ||
    typeof body.issuer !== "string"
  ) {
    throw new HostedFlowError(
      `Atlas auth discovery is missing one of: authorization_endpoint, token_endpoint, registration_endpoint, issuer`,
      "discovery_failed",
    );
  }
  return {
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    registration_endpoint: body.registration_endpoint,
    issuer: body.issuer,
  };
}

async function register(
  metadata: AuthServerMetadata,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  // Public client — no `client_secret`. `token_endpoint_auth_method: "none"`
  // matches the public-client posture; the server enforces PKCE.
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: REQUESTED_SCOPE,
    token_endpoint_auth_method: "none",
  };
  let res: Response;
  try {
    res = await fetchImpl(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HostedFlowError(
      `Dynamic Client Registration failed: ${msg}`,
      "registration_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HostedFlowError(
      `Dynamic Client Registration returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      "registration_failed",
    );
  }
  const data = (await res.json().catch((err) => {
    throw new HostedFlowError(
      `Dynamic Client Registration response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "registration_failed",
      { cause: err },
    );
  })) as Partial<RegistrationResponse>;
  if (typeof data.client_id !== "string" || data.client_id.length === 0) {
    throw new HostedFlowError(
      `Dynamic Client Registration response missing client_id`,
      "registration_failed",
    );
  }
  return data.client_id;
}

interface BuildAuthorizeUrlArgs {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: REQUESTED_SCOPE,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  // Robust against authorization endpoints that already carry query
  // (rare, but cheap to handle).
  const sep = args.authorizationEndpoint.includes("?") ? "&" : "?";
  return `${args.authorizationEndpoint}${sep}${params.toString()}`;
}

interface ExchangeArgs {
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl: typeof fetch;
}

async function exchangeCode(args: ExchangeArgs): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
  });
  let res: Response;
  try {
    res = await args.fetchImpl(args.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HostedFlowError(
      `Token exchange failed: ${msg}`,
      "token_exchange_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HostedFlowError(
      `Token endpoint returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      "token_exchange_failed",
    );
  }
  const data = (await res.json().catch((err) => {
    throw new HostedFlowError(
      `Token endpoint response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "token_exchange_failed",
      { cause: err },
    );
  })) as Partial<TokenResponse>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new HostedFlowError(
      `Token endpoint response missing access_token`,
      "token_exchange_failed",
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    token_type: typeof data.token_type === "string" ? data.token_type : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
  };
}

/**
 * Decode a JWT payload WITHOUT verifying the signature. Safe here only
 * because we just minted the token through a TLS-protected OAuth flow
 * against an issuer we discovered ourselves (`validateApiUrl` +
 * `enforceIssuer`). The hosted MCP endpoint re-verifies the signature
 * on every request via JWKS, so any tampering between here and there is
 * rejected server-side.
 *
 * Do NOT lift this helper out as a generic JWT decoder — without the
 * surrounding flow's TLS + issuer guarantees, "decode without verify" is
 * unsafe.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new HostedFlowError(
      `Access token is not a JWT (expected 3 parts, got ${parts.length})`,
      "missing_workspace_claim",
    );
  }
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new HostedFlowError(
      `Could not decode JWT payload: ${err instanceof Error ? err.message : String(err)}`,
      "missing_workspace_claim",
      { cause: err },
    );
  }
}

/**
 * Defense-in-depth: if the discovered issuer doesn't match the JWT's
 * `iss` claim, the auth server returned a token "for" a different
 * issuer. That's either a server bug or a discovery-redirection attack;
 * either way, refuse to write it to disk.
 */
function enforceIssuer(payload: Record<string, unknown>, expectedIssuer: string): void {
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    throw new HostedFlowError(
      `Access token has no \`iss\` claim — refusing to trust an unsigned-issuer token.`,
      "issuer_mismatch",
    );
  }
  if (iss !== expectedIssuer) {
    throw new HostedFlowError(
      `Access token issuer mismatch: discovered \`${expectedIssuer}\`, token claims \`${iss}\`.`,
      "issuer_mismatch",
    );
  }
}

function extractWorkspaceClaim(payload: Record<string, unknown>): string {
  const claim = payload[WORKSPACE_CLAIM];
  if (typeof claim !== "string" || claim.length === 0) {
    throw new HostedFlowError(
      `Access token is missing the ${WORKSPACE_CLAIM} claim — was the token issued for an MCP scope?`,
      "missing_workspace_claim",
    );
  }
  return claim;
}

// ── Loopback listener — handler factory + default Bun.serve impl ───────

interface CallbackResolver {
  /** Single-shot handler that resolves/rejects the promise. */
  handler: LoopbackHandler;
  /** Resolves with the authorization code on success. */
  promise: Promise<string>;
  /**
   * Tear down the timer and settle the promise as a no-op rejection.
   * Called from the outer `finally` block on every flow exit so a
   * 5-minute timeout can never survive an early-step failure (would
   * otherwise keep the event loop alive long after the CLI returned).
   */
  cancel(): void;
}

function createCallbackResolver(
  expectedState: string,
  timeoutMs: number,
): CallbackResolver {
  let resolve!: (code: string) => void;
  let reject!: (err: HostedFlowError) => void;
  let settled = false;

  const promise = new Promise<string>((res, rej) => {
    resolve = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(code);
    };
    reject = (err: HostedFlowError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rej(err);
    };
  });

  const timer = setTimeout(() => {
    reject(
      new HostedFlowError(
        `Did not receive an authorization callback within ${Math.round(timeoutMs / 1000)}s. If the browser didn't open, try \`bunx @useatlas/mcp init --hosted\` again from a desktop session.`,
        "callback_timeout",
      ),
    );
  }, timeoutMs);

  const handler: LoopbackHandler = (params, method) => {
    if (method !== "GET") {
      // RFC 8252 §7.3 + OAuth 2.1 §3.1.2.5 — the redirect URI is fetched
      // by the user-agent on completion of the authorization step;
      // anything other than GET is an attempt to inject parameters
      // out-of-band. Reject without settling so a probe can't preempt
      // the legitimate callback.
      return {
        status: 405,
        body: renderCallbackPage({
          ok: false,
          message: "Method not allowed. The OAuth callback must be a GET.",
        }),
      };
    }
    const error = params.get("error");
    if (error) {
      const description = params.get("error_description") ?? "";
      reject(
        new HostedFlowError(
          `Authorization server returned error \`${error}\`${description ? `: ${description}` : ""}`,
          "callback_oauth_error",
        ),
      );
      return {
        status: 400,
        body: renderCallbackPage({
          ok: false,
          message: `Authorization failed: ${error}${description ? ` — ${description}` : ""}`,
        }),
      };
    }
    const state = params.get("state");
    if (state !== expectedState) {
      reject(
        new HostedFlowError(
          `OAuth state mismatch — possible CSRF. Got \`${state ?? "<missing>"}\`, expected the value generated for this run.`,
          "callback_state_mismatch",
        ),
      );
      return {
        status: 400,
        body: renderCallbackPage({
          ok: false,
          message: "State mismatch — refusing to complete the flow.",
        }),
      };
    }
    const code = params.get("code");
    if (!code) {
      reject(
        new HostedFlowError(
          `Authorization callback was missing the \`code\` parameter.`,
          "callback_missing_code",
        ),
      );
      return {
        status: 400,
        body: renderCallbackPage({
          ok: false,
          message: "Missing authorization code in the callback URL.",
        }),
      };
    }
    resolve(code);
    return {
      status: 200,
      body: renderCallbackPage({
        ok: true,
        message: "Atlas MCP CLI is now authorized. You can close this tab.",
      }),
    };
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Settle as a rejection so any awaiter that's still listening sees
    // a typed error. The outer flow attaches a no-op .catch() on the
    // promise to defuse unhandled-rejection on the abort path.
    reject(
      new HostedFlowError(
        "OAuth flow aborted before the authorization callback arrived.",
        "callback_timeout",
      ),
    );
  };

  return { handler, promise, cancel };
}

/**
 * Default loopback listener — Bun.serve on 127.0.0.1:0. The handler runs
 * once: subsequent requests get a 410 (the auth flow already settled).
 */
const defaultServeImpl: ServeImpl = async (handler) => {
  // Once-fired guard. RFC 8252 §8.10 recommends rejecting all but the
  // first request to the redirect URI — replays could only ever be
  // probes since the legitimate auth code is single-use server-side.
  let used = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not Found", { status: 404 });
      }
      if (used) {
        // 404 (not 410) so a fingerprinting probe can't tell whether
        // the listener was live-but-consumed vs never bound.
        return new Response("Not Found", { status: 404 });
      }
      used = true;
      const result = handler(url.searchParams, req.method);
      return new Response(result.body, {
        status: result.status,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  // Bun.serve types port as `number | undefined` (Unix-socket configs
  // don't carry a TCP port). We bound `port: 0` above so a TCP port is
  // always assigned — narrow defensively rather than ! through it.
  if (typeof server.port !== "number") {
    await server.stop(true);
    throw new HostedFlowError(
      "Loopback listener bound but did not report a TCP port",
      "loopback_bind_failed",
    );
  }
  return {
    port: server.port,
    stop: async () => {
      // Bun ≥1.1 returns a Promise from stop(); older versions returned
      // void. Detect at runtime so this works on either.
      const out = (server as unknown as { stop: (closeActive?: boolean) => unknown }).stop(true);
      if (out && typeof (out as Promise<unknown>).then === "function") {
        await (out as Promise<unknown>);
      }
    },
  };
};

interface CallbackPageOpts {
  ok: boolean;
  message: string;
}

function renderCallbackPage(opts: CallbackPageOpts): string {
  const title = opts.ok ? "Atlas MCP — authorized" : "Atlas MCP — error";
  const accent = opts.ok ? "#10b981" : "#ef4444";
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  .card { max-width: 420px; padding: 32px; border-radius: 12px; background: #111; border: 1px solid #222; text-align: center; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${accent}; display: inline-block; margin-right: 8px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #a1a1aa; margin: 0; line-height: 1.5; }
</style>
</head><body>
<div class="card"><h1><span class="dot"></span>${title}</h1><p>${opts.message}</p></div>
</body></html>`;
}

// ── Default browser launcher ───────────────────────────────────────────

const defaultOpenBrowserImpl: OpenBrowserImpl = async (url) => {
  // Bun.spawn is the cross-platform shell here. Each platform's own
  // helper handles browser-detection, focus, and security prompts —
  // we just need to invoke it. If the helper isn't found, return
  // ok:false so the caller falls back to "open this URL manually".
  const platform = process.platform;
  const cmd = platform === "darwin" ? ["open", url]
    : platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      return { ok: false, detail: stderr.trim() || `exit ${exitCode}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
};

// ── Crypto helpers ─────────────────────────────────────────────────────

function defaultRandomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

function encodeBase64Url(bytes: Uint8Array): string {
  // bun ships btoa; convert via binary-string round-trip.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeBase64Url(new Uint8Array(digest));
}
