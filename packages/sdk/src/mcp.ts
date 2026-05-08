/**
 * `@useatlas/sdk` programmatic MCP onboarding helper (#2079).
 *
 * Mirrors the OAuth 2.1 + DCR loopback flow that the
 * `@useatlas/mcp init --hosted` CLI runs (in `plugins/mcp/src/init/hosted.ts`)
 * but reshaped so it can run from a server-side framework, a browser,
 * an embedded React component, or a Node CI script. The CLI binds a
 * `127.0.0.1:0` loopback listener to receive the redirect; the SDK
 * delegates that step to the caller — it returns the `authorizationUrl`
 * for the caller to open (popup / redirect / new tab) and exposes
 * `completeConnect` to exchange the resulting `code` for a JWT.
 *
 * ── Single-workspace baseline ──────────────────────────────────────
 *
 * Single-workspace is the only shape today because cross-workspace
 * agent identity (#2073, Theme C3 of milestone 1.4.1) had not landed
 * when this module shipped. Once C3 lands, the multi-workspace shape
 * tracks via #2196: `beginConnect`/`buildConfig` will accept an
 * optional `workspaceId?`, and `buildConfig` will emit the workspace-
 * aware config block when the token's claims cover multiple
 * workspaces. The current single-workspace surface stays backward-
 * compatible.
 *
 * ── What the caller must persist between begin → complete ───────────
 *
 * `state`, `codeVerifier`, `clientId`, and `tokenEndpoint` are returned
 * from `beginConnect` and required by `completeConnect`. In a browser
 * popup flow the caller stores them in `sessionStorage`; in a server-
 * side flow the caller stashes them in the user's session record.
 *
 * The hook in `@useatlas/react` wraps this lifecycle for the popup
 * case so SDK consumers don't reimplement the bookkeeping.
 *
 * ── Tree-shaking ──────────────────────────────────────────────────
 *
 * This module imports nothing from `@modelcontextprotocol/sdk` — only
 * the standard browser/node OAuth + crypto primitives. Anyone who never
 * imports `mcp.ts` pays nothing.
 */

// ── Errors ────────────────────────────────────────────────────────────

export type AtlasMcpErrorCode =
  | "invalid_api_url"
  | "discovery_failed"
  | "registration_failed"
  | "callback_state_mismatch"
  | "callback_missing_code"
  | "token_exchange_failed"
  | "issuer_mismatch"
  | "malformed_jwt"
  | "missing_workspace_claim"
  | "grant_not_supported";

export class AtlasMcpError extends Error {
  readonly code: AtlasMcpErrorCode;
  constructor(message: string, code: AtlasMcpErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "AtlasMcpError";
    this.code = code;
  }
}

// ── Constants ─────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30 * 1000;
const DEFAULT_SCOPES: ReadonlyArray<string> = [
  "mcp:read",
  "offline_access",
];
const WORKSPACE_CLAIM = "https://atlas.useatlas.dev/workspace_id";

// ── Public types ──────────────────────────────────────────────────────

export interface BeginConnectOptions {
  /**
   * Atlas API base — e.g. `https://mcp.useatlas.dev`. Discovery doc lives
   * at `${apiUrl}/.well-known/oauth-authorization-server/api/auth`. Must
   * be `https://`, except for `http://127.0.0.1` / `http://localhost`
   * which are accepted for local-dev testing.
   */
  apiUrl: string;
  /** Human-readable name registered via DCR — shown on the consent screen. */
  clientName: string;
  /**
   * Where the auth server should send the user after consent. Must match
   * the `redirect_uri` the caller listens on (e.g. a `/oauth/callback`
   * page in a Next.js app or the popup-host page in a browser flow).
   */
  redirectUri: string;
  /** Defaults to `["mcp:read", "offline_access"]`. */
  scopes?: ReadonlyArray<string>;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to `crypto.getRandomValues`. */
  randomBytesImpl?: (length: number) => Uint8Array;
}

export interface BeginConnectResult {
  /** URL the caller redirects/popup-opens for the user to consent. */
  authorizationUrl: string;
  /**
   * Anti-CSRF state. Caller must echo this back to `completeConnect.expectedState`
   * when the callback fires.
   */
  state: string;
  /**
   * PKCE code verifier. Caller must persist between begin and complete
   * (sessionStorage in a browser, session record on a server).
   */
  codeVerifier: string;
  /** DCR-issued client_id for this caller. Persist alongside `codeVerifier`. */
  clientId: string;
  /** Cached for `completeConnect` so it doesn't re-discover. */
  tokenEndpoint: string;
  /** Discovered issuer claim — used to verify the JWT's `iss`. */
  issuer: string;
}

export interface CompleteConnectOptions {
  apiUrl: string;
  /** State value received in the callback (`?state=`). */
  state: string;
  /** State value originally returned from `beginConnect`. */
  expectedState: string;
  /** Authorization code received in the callback (`?code=`). */
  code: string;
  /** PKCE verifier from `beginConnect`. */
  codeVerifier: string;
  /** DCR-issued client_id from `beginConnect`. */
  clientId: string;
  /** Same `redirect_uri` you passed to `beginConnect`. */
  redirectUri: string;
  /** From `beginConnect.tokenEndpoint` — skips a re-discover roundtrip. */
  tokenEndpoint?: string;
  /** From `beginConnect.issuer` — used to verify the JWT's `iss` claim. */
  issuer?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export interface CompleteConnectResult {
  /** OAuth 2.1 access token (signed JWT). Treat as a credential. */
  accessToken: string;
  /** OAuth 2.1 refresh token, when offline_access was granted. */
  refreshToken: string | null;
  /** ms epoch — derived from `expires_in` at exchange time. */
  expiresAt: number;
  /** `https://atlas.useatlas.dev/workspace_id` claim from the JWT. */
  workspaceId: string;
}

export type McpClientId =
  | "claude-desktop"
  | "cursor"
  | "continue"
  | "chatgpt"
  | "generic";

export interface BuildConfigOptions {
  client: McpClientId;
  apiUrl: string;
  accessToken: string;
  workspaceId: string;
  /** Override the `mcpServers["..."]` key. Defaults to `"atlas"`. */
  serverName?: string;
}

export interface McpHttpServer {
  url: string;
  headers: { Authorization: string };
}

export interface McpClientConfig {
  /** Set when `client` is one of the wrapper-style entries. */
  mcpServers?: Record<string, McpHttpServer>;
  /** Set when `client` is `"generic"` — the bare server block. */
  url?: string;
  /** Set when `client` is `"generic"` — the bare server block. */
  headers?: { Authorization: string };
}

export interface ConnectMachineToMachineOptions {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: ReadonlyArray<string>;
  fetchImpl?: typeof fetch;
}

export interface ConnectMachineToMachineResult {
  accessToken: string;
  expiresAt: number;
}

// ── beginConnect ──────────────────────────────────────────────────────

export async function beginConnect(
  options: BeginConnectOptions,
): Promise<BeginConnectResult> {
  const apiUrl = trimTrailingSlash(options.apiUrl);
  validateApiUrl(apiUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const randomBytes = options.randomBytesImpl ?? defaultRandomBytes;
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  const metadata = await discover(apiUrl, fetchImpl);

  const state = encodeBase64Url(randomBytes(32));
  const codeVerifier = encodeBase64Url(randomBytes(32));
  const codeChallenge = await pkceChallenge(codeVerifier);

  const clientId = await register({
    metadata,
    redirectUri: options.redirectUri,
    clientName: options.clientName,
    scopes,
    fetchImpl,
  });

  const authorizationUrl = buildAuthorizeUrl({
    authorizationEndpoint: metadata.authorization_endpoint,
    clientId,
    redirectUri: options.redirectUri,
    state,
    codeChallenge,
    scopes,
  });

  return {
    authorizationUrl,
    state,
    codeVerifier,
    clientId,
    tokenEndpoint: metadata.token_endpoint,
    issuer: metadata.issuer,
  };
}

// ── completeConnect ───────────────────────────────────────────────────

export async function completeConnect(
  options: CompleteConnectOptions,
): Promise<CompleteConnectResult> {
  if (options.state !== options.expectedState) {
    throw new AtlasMcpError(
      `OAuth state mismatch — possible CSRF. Got \`${options.state}\`, expected the value returned from beginConnect.`,
      "callback_state_mismatch",
    );
  }
  if (!options.code) {
    throw new AtlasMcpError(
      `Authorization callback was missing the \`code\` parameter.`,
      "callback_missing_code",
    );
  }

  const apiUrl = trimTrailingSlash(options.apiUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  let tokenEndpoint = options.tokenEndpoint;
  let issuer = options.issuer;
  if (!tokenEndpoint || !issuer) {
    const metadata = await discover(apiUrl, fetchImpl);
    tokenEndpoint = tokenEndpoint ?? metadata.token_endpoint;
    issuer = issuer ?? metadata.issuer;
  }

  const tokenResponse = await exchangeCode({
    tokenEndpoint,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    code: options.code,
    codeVerifier: options.codeVerifier,
    fetchImpl,
  });

  const claims = decodeJwtPayload(tokenResponse.access_token);
  enforceIssuer(claims, issuer);
  const workspaceId = extractWorkspaceClaim(claims);

  const expiresIn =
    typeof tokenResponse.expires_in === "number" && tokenResponse.expires_in > 0
      ? tokenResponse.expires_in
      : 3600;

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    expiresAt: Date.now() + expiresIn * 1000,
    workspaceId,
  };
}

// ── buildConfig ───────────────────────────────────────────────────────

const SERVER_NAME_DEFAULT = "atlas";

export function buildConfig(options: BuildConfigOptions): McpClientConfig {
  const apiUrl = trimTrailingSlash(options.apiUrl);
  const url = `${apiUrl}/mcp/${options.workspaceId}/sse`;
  const block: McpHttpServer = {
    url,
    headers: { Authorization: `Bearer ${options.accessToken}` },
  };

  if (options.client === "generic") {
    return { url: block.url, headers: block.headers };
  }
  const name = options.serverName ?? SERVER_NAME_DEFAULT;
  return { mcpServers: { [name]: block } };
}

// ── connectMachineToMachine ──────────────────────────────────────────

/**
 * Server-to-server flow using the OAuth `client_credentials` grant.
 *
 * Throws `AtlasMcpError(code: "grant_not_supported")` until the Atlas
 * OAuth provider exposes the grant. Tracking issue: #2024 lists
 * `client_credentials` as deferred. When the provider lands the grant,
 * swap this body for the live exchange — the public surface is fixed.
 */
export async function connectMachineToMachine(
  _options: ConnectMachineToMachineOptions,
): Promise<ConnectMachineToMachineResult> {
  throw new AtlasMcpError(
    "client_credentials grant is not yet enabled on the Atlas OAuth provider — see #2024 deferred work. Use the authorization-code flow (beginConnect / completeConnect) for now.",
    "grant_not_supported",
  );
}

// ── HTTP-client helpers shared by the SDK client.mcp namespace ───────
//
// These return SHAPES the AtlasClient can consume — they are not the
// actual fetch wiring (the client owns its auth header + error handling).

export interface ListAgentsResponse {
  clients: Array<{
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
    createdAt: string;
    updatedAt: string | null;
    disabled: boolean;
    type: string | null;
    lastUsedAt: string | null;
    tokenCount: number;
    tokenState: "active" | "reconnect_required" | "revoked";
  }>;
  deployMode: "self-hosted" | "saas";
}

export interface RevokeAgentResponse {
  success: boolean;
  tokensRevoked: number;
}

// ── Internals ─────────────────────────────────────────────────────────

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  issuer: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function validateApiUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch (err) {
    throw new AtlasMcpError(
      `apiUrl is not a valid URL: ${apiUrl}`,
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
  throw new AtlasMcpError(
    `apiUrl must use https:// (or http://localhost for dev). Got: ${apiUrl}`,
    "invalid_api_url",
  );
}

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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AtlasMcpError(
      `Could not reach Atlas auth discovery at ${url}: ${msg}`,
      "discovery_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new AtlasMcpError(
      `Atlas auth discovery returned ${res.status} for ${url}`,
      "discovery_failed",
    );
  }
  const body = (await res.json().catch((err) => {
    throw new AtlasMcpError(
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
    throw new AtlasMcpError(
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

interface RegisterArgs {
  metadata: AuthServerMetadata;
  redirectUri: string;
  clientName: string;
  scopes: ReadonlyArray<string>;
  fetchImpl: typeof fetch;
}

async function register(args: RegisterArgs): Promise<string> {
  // Public-client posture — `token_endpoint_auth_method: "none"` matches
  // the CLI loopback flow; the server enforces PKCE.
  const body = {
    client_name: args.clientName,
    redirect_uris: [args.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: args.scopes.join(" "),
    token_endpoint_auth_method: "none",
  };
  let res: Response;
  try {
    res = await args.fetchImpl(args.metadata.registration_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AtlasMcpError(
      `Dynamic Client Registration failed: ${msg}`,
      "registration_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    const detail = await describeErrorBody(res);
    throw new AtlasMcpError(
      `Dynamic Client Registration returned ${res.status}${detail ? `: ${detail}` : ""}`,
      "registration_failed",
    );
  }
  const data = (await res.json().catch((err) => {
    throw new AtlasMcpError(
      `Dynamic Client Registration response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "registration_failed",
      { cause: err },
    );
  })) as Partial<{ client_id: string }>;
  if (typeof data.client_id !== "string" || data.client_id.length === 0) {
    throw new AtlasMcpError(
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
  scopes: ReadonlyArray<string>;
}

function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.scopes.join(" "),
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AtlasMcpError(
      `Token exchange failed: ${msg}`,
      "token_exchange_failed",
      { cause: err },
    );
  }
  if (!res.ok) {
    const detail = await describeErrorBody(res);
    throw new AtlasMcpError(
      `Token endpoint returned ${res.status}${detail ? `: ${detail}` : ""}`,
      "token_exchange_failed",
    );
  }
  const data = (await res.json().catch((err) => {
    throw new AtlasMcpError(
      `Token endpoint response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      "token_exchange_failed",
      { cause: err },
    );
  })) as Partial<TokenResponse>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new AtlasMcpError(
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

async function describeErrorBody(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Partial<{
      error: string;
      error_description: string;
      error_uri: string;
    }>;
    const parts: string[] = [];
    if (typeof parsed.error === "string" && parsed.error.length > 0) parts.push(parsed.error);
    if (typeof parsed.error_description === "string" && parsed.error_description.length > 0) {
      parts.push(parsed.error_description);
    }
    if (typeof parsed.error_uri === "string" && parsed.error_uri.length > 0) {
      parts.push(`see ${parsed.error_uri}`);
    }
    if (parts.length > 0) return parts.join(": ");
  } catch {
    // intentionally ignored: not JSON — fall through to raw-text branch.
  }
  return raw.length > 1024 ? `${raw.slice(0, 1024)}…` : raw;
}

/**
 * Decode a JWT payload WITHOUT verifying the signature. Safe here only
 * because we just minted the token through a TLS-protected OAuth flow
 * against an issuer we discovered ourselves. The hosted MCP endpoint
 * re-verifies the signature on every request via JWKS, so any tampering
 * between here and there is rejected server-side. Do NOT lift this
 * helper out as a generic JWT decoder — without the surrounding flow's
 * TLS + issuer guarantees, "decode without verify" is unsafe.
 */
function decodeJwtPayload(jwtToken: string): Record<string, unknown> {
  const parts = jwtToken.split(".");
  if (parts.length !== 3) {
    throw new AtlasMcpError(
      `Access token is not a JWT (expected 3 parts, got ${parts.length})`,
      "malformed_jwt",
    );
  }
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new AtlasMcpError(
      `Could not decode JWT payload: ${err instanceof Error ? err.message : String(err)}`,
      "malformed_jwt",
      { cause: err },
    );
  }
}

function enforceIssuer(payload: Record<string, unknown>, expectedIssuer: string): void {
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    throw new AtlasMcpError(
      `Access token has no \`iss\` claim — refusing to trust an unsigned-issuer token.`,
      "issuer_mismatch",
    );
  }
  if (iss !== expectedIssuer) {
    throw new AtlasMcpError(
      `Access token issuer mismatch: discovered \`${expectedIssuer}\`, token claims \`${iss}\`.`,
      "issuer_mismatch",
    );
  }
}

function extractWorkspaceClaim(payload: Record<string, unknown>): string {
  const claim = payload[WORKSPACE_CLAIM];
  if (typeof claim !== "string" || claim.length === 0) {
    throw new AtlasMcpError(
      `Access token is missing the ${WORKSPACE_CLAIM} claim — was the token issued for an MCP scope?`,
      "missing_workspace_claim",
    );
  }
  return claim;
}

function defaultRandomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeBase64Url(new Uint8Array(digest));
}
