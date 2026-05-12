/**
 * Programmatic MCP onboarding helpers — OAuth 2.1 + DCR + PKCE flow
 * reshaped so it runs from a server-side framework, a browser, an
 * embedded React component, or a Node CI script. The
 * `@useatlas/mcp init --hosted` CLI binds a `127.0.0.1:0` loopback
 * listener to receive the redirect; this module delegates that step
 * to the caller — `beginConnect` returns the `authorizationUrl` for
 * the caller to open (popup / redirect / new tab) and `completeConnect`
 * exchanges the resulting `code` for a JWT.
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
 * the standard browser/node OAuth + crypto primitives via the shared
 * `@atlas/oauth-helper`, which is bundled into the SDK at build time
 * (it is never resolved from npm). The published `.d.ts` does not
 * import or re-export the helper package — the JSDoc references it,
 * but TypeScript doesn't resolve those. Anyone who never imports
 * `mcp.ts` pays nothing.
 */

import {
  OAuthHelperError,
  buildAuthorizationUrl,
  decodeJwtPayload,
  discover,
  enforceIssuer,
  exchangeCode,
  generatePkce,
  generateState,
  register,
  validateIssuerUrl,
  validateTokenEndpoint,
  type OAuthHelperErrorCode,
} from "@atlas/oauth-helper";

// ── Errors ────────────────────────────────────────────────────────────

/**
 * Error codes carried by `AtlasMcpError`. The first eight values are
 * 1:1 with `@atlas/oauth-helper`'s `OAuthHelperErrorCode` (re-declared
 * inline so the published `.d.ts` doesn't import the internal-only
 * helper package). The next three (`callback_*`) are produced inside
 * the SDK proper. The remaining popup codes (`popup_blocked`,
 * `popup_closed`) are reserved for the React popup driver in
 * `@useatlas/react`'s `use-mcp-connect`, which throws against this
 * union; the SDK proper never throws those itself.
 */
export type AtlasMcpErrorCode =
  | "invalid_api_url"
  | "invalid_token_endpoint"
  | "discovery_failed"
  | "registration_failed"
  | "token_exchange_failed"
  | "issuer_mismatch"
  | "malformed_jwt"
  | "missing_workspace_claim"
  | "callback_state_mismatch"
  | "callback_state_missing"
  | "callback_missing_code"
  | "popup_blocked"
  | "popup_closed"
  | "grant_not_supported";

/**
 * Compile-time witness that `OAuthHelperErrorCode ⊂ AtlasMcpErrorCode`.
 * If a future helper code arm doesn't exist on `AtlasMcpErrorCode`,
 * `_HelperCodeIsSubset` resolves to `never` and the assignment fails
 * the type check. Catches the drift class the `liftHelper` casts below
 * implicitly assume.
 */
type _HelperCodeIsSubset = OAuthHelperErrorCode extends AtlasMcpErrorCode
  ? true
  : never;
const _atlasMcpErrorCodeWitness: _HelperCodeIsSubset = true;
void _atlasMcpErrorCodeWitness;

export class AtlasMcpError extends Error {
  readonly code: AtlasMcpErrorCode;
  constructor(message: string, code: AtlasMcpErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "AtlasMcpError";
    this.code = code;
  }
}

/**
 * Wrap a helper call so any `OAuthHelperError` is re-thrown as an
 * `AtlasMcpError` with the same code. The `_atlasMcpErrorCodeWitness`
 * above proves the cast at compile time.
 *
 * Non-`OAuthHelperError` throws (e.g. a misconfigured `fetchImpl`
 * panicking with a `TypeError`) bypass the typed-error contract by
 * design — the helper layer is the only legitimate source of
 * `OAuthHelperError`, so anything else is a programmer error worth
 * surfacing with its original stack rather than coerced into a fake
 * `AtlasMcpErrorCode`.
 */
async function liftHelper<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuthHelperError) {
      throw new AtlasMcpError(err.message, err.code, { cause: err });
    }
    throw err;
  }
}

function liftHelperSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OAuthHelperError) {
      throw new AtlasMcpError(err.message, err.code, { cause: err });
    }
    throw err;
  }
}

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_SCOPES: ReadonlyArray<string> = ["mcp:read", "offline_access"];
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
  /**
   * From `beginConnect.tokenEndpoint` — skips a re-discover roundtrip.
   * Pass alongside `issuer`; passing only one re-discovers and ignores
   * the partial input.
   */
  tokenEndpoint?: string;
  /**
   * From `beginConnect.issuer` — used to verify the JWT's `iss` claim.
   * Pass alongside `tokenEndpoint`.
   */
  issuer?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export interface CompleteConnectResult {
  /** OAuth 2.1 access token (signed JWT). Treat as a credential. */
  accessToken: string;
  /** OAuth 2.1 refresh token, when offline_access was granted. */
  refreshToken: string | null;
  /**
   * ms epoch. Derived from `expires_in` at exchange time; falls back
   * to one hour from now when the token endpoint omits `expires_in`,
   * so callers scheduling refresh against a server with a non-standard
   * lifetime should re-check expiry from the JWT itself.
   */
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

/**
 * Discriminated by `client`:
 * - `"generic"` returns the bare server block — `{ url, headers }`.
 * - everything else returns the wrapped block —
 *   `{ mcpServers: { [serverName]: McpHttpServer } }`.
 *
 * Splitting these as a tagged union (instead of one bag with optional
 * fields) means a consumer that destructures `cfg` gets only the
 * fields that are actually present for the chosen client, without
 * needing runtime guards.
 */
export interface McpWrappedConfig {
  readonly kind: "wrapped";
  readonly mcpServers: Record<string, McpHttpServer>;
}

export interface McpBareConfig extends McpHttpServer {
  readonly kind: "bare";
}

export type McpClientConfig = McpWrappedConfig | McpBareConfig;

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
  liftHelperSync(() => validateIssuerUrl(apiUrl));
  const fetchImpl = options.fetchImpl ?? fetch;
  const randomBytesImpl = options.randomBytesImpl;
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  return liftHelper(async () => {
    const metadata = await discover(apiUrl, { fetchImpl });

    const state = generateState({ randomBytesImpl });
    const { codeVerifier, codeChallenge } = await generatePkce({ randomBytesImpl });

    const clientId = await register(
      metadata,
      {
        redirectUri: options.redirectUri,
        clientName: options.clientName,
        scopes,
      },
      { fetchImpl },
    );

    const authorizationUrl = buildAuthorizationUrl({
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
  });
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
  liftHelperSync(() => validateIssuerUrl(apiUrl));
  const fetchImpl = options.fetchImpl ?? fetch;

  return liftHelper(async () => {
    let tokenEndpoint = options.tokenEndpoint;
    let issuer = options.issuer;
    if (!tokenEndpoint || !issuer) {
      const metadata = await discover(apiUrl, { fetchImpl });
      tokenEndpoint = tokenEndpoint ?? metadata.token_endpoint;
      issuer = issuer ?? metadata.issuer;
    }
    // Defense-in-depth: a malicious DCR response can advertise a plain-
    // http token endpoint. The helper validates internally inside
    // `exchangeCode`, but checking here keeps the failure mode close to
    // the caller's `tokenEndpoint` input — easier to debug a typo'd
    // override than a deep stack from inside the exchange. Lives inside
    // the outer `liftHelper(async () => …)` block so its sync throw is
    // translated by the surrounding try/catch.
    validateTokenEndpoint(tokenEndpoint);

    const tokenResponse = await exchangeCode(
      {
        tokenEndpoint,
        clientId: options.clientId,
        redirectUri: options.redirectUri,
        code: options.code,
        codeVerifier: options.codeVerifier,
      },
      { fetchImpl },
    );

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
  });
}

// ── buildConfig ───────────────────────────────────────────────────────

const SERVER_NAME_DEFAULT = "atlas";

export function buildConfig(options: BuildConfigOptions): McpClientConfig {
  const apiUrl = trimTrailingSlash(options.apiUrl);
  // workspaceId is opaque server-issued; encode it defensively so a
  // value containing path-sensitive characters can't reshape the URL.
  const url = `${apiUrl}/mcp/${encodeURIComponent(options.workspaceId)}/sse`;
  const block: McpHttpServer = {
    url,
    headers: { Authorization: `Bearer ${options.accessToken}` },
  };
  const name = options.serverName ?? SERVER_NAME_DEFAULT;

  // Exhaustive switch on the discriminator — adding a new client to
  // `McpClientId` without extending this dispatch fails compilation
  // via `assertNever` rather than silently falling into the wrapped
  // branch with the wrong shape.
  switch (options.client) {
    case "generic":
      return { kind: "bare", url: block.url, headers: block.headers };
    case "claude-desktop":
    case "cursor":
    case "continue":
    case "chatgpt":
      return { kind: "wrapped", mcpServers: { [name]: block } };
    default:
      return assertNever(options.client);
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled MCP client id: ${String(x)}`);
}

// ── connectMachineToMachine ──────────────────────────────────────────

/**
 * Server-to-server flow using the OAuth `client_credentials` grant.
 *
 * Throws `AtlasMcpError(code: "grant_not_supported")` until the Atlas
 * OAuth provider exposes the grant. The public surface is fixed; when
 * the provider lands the grant (tracking issue: see roadmap), swap
 * this body for the live exchange without changing the type.
 */
export async function connectMachineToMachine(
  _options: ConnectMachineToMachineOptions,
): Promise<ConnectMachineToMachineResult> {
  throw new AtlasMcpError(
    "client_credentials grant is not yet enabled on the Atlas OAuth provider. Use the authorization-code flow (beginConnect / completeConnect) for now.",
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

function trimTrailingSlash(s: string): string {
  // Non-regex to keep the polynomial-ReDoS checker happy on `\/+$`.
  let i = s.length;
  while (i > 0 && s[i - 1] === "/") i--;
  return i === s.length ? s : s.slice(0, i);
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
