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
  | "grant_not_supported"
  | "workspace_not_in_grant_list";

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
/**
 * Plural workspace-ids claim (#2073). Emitted by the Atlas Better Auth
 * `customAccessTokenClaims` hook ONLY when the authenticating user
 * belongs to more than one workspace. Read here for the same reason the
 * CLI reads it: lets the embedder render a workspace picker without a
 * follow-up `/me/workspaces` roundtrip. The runtime authorization layer
 * at the MCP edge ignores this claim — it does a live grants-table
 * lookup so membership revocation is immediate; the claim is purely a
 * UX affordance.
 */
const WORKSPACES_CLAIM = "https://atlas.useatlas.dev/workspace_ids";

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
  /**
   * Forward-compat slot (#2196). **No-op today.** The Atlas OAuth
   * provider does not yet accept a workspace hint on the authorize
   * endpoint — server-side claim issuance reads the user's session at
   * consent time and emits the singular + (optionally) plural claims
   * based on membership, regardless of what you pass here. Reserved so
   * the SDK surface doesn't need to change when the provider lands
   * the hint.
   *
   * Passing this option today has no observable effect — to get a
   * multi-workspace token, just ensure the authenticating user belongs
   * to more than one workspace. The plural claim then surfaces on
   * `completeConnect`'s result as `workspaces`.
   */
  workspaceId?: string;
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
  /**
   * `https://atlas.useatlas.dev/workspace_ids` plural claim (#2196) — the
   * complete set of workspaces this token grants access to, in the order
   * the server emitted them. Empty array when the token was minted for
   * a user belonging to exactly one workspace (the server omits the
   * plural claim in that case). Always a stable type so embedders
   * rendering a workspace picker don't need to null-check.
   *
   * Typed `ReadonlyArray<string>` so consumers can't mutate the
   * SDK-owned array in place (the value is held in `useState` inside
   * `useMcpConnect`; an in-place `.sort()` would silently mutate React
   * state). Pipes cleanly into `buildConfig({ workspaces })` whose
   * input shape is the same.
   *
   * The runtime authorization layer at the MCP edge does NOT rely on
   * this list — membership is re-checked against the live grants table
   * on every request so revocation is immediate. Treat the array as a
   * UX affordance, not a security boundary.
   */
  workspaces: ReadonlyArray<string>;
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
  /**
   * Workspace pinned in the connection URL. Even for multi-workspace
   * tokens this is required — the hosted MCP edge mounts at
   * `/mcp/{workspace_id}/sse`. For multi-workspace setups pass the
   * default-workspace id (typically the singular claim from
   * `completeConnect`); per-request overrides happen via the
   * `X-Atlas-Workspace` header.
   */
  workspaceId: string;
  /** Override the `mcpServers["..."]` key. Defaults to `"atlas"`. */
  serverName?: string;
  /**
   * Multi-workspace opt-in (#2196). Pass the full list of workspaces
   * this token grants access to (the `workspaces` field from
   * `completeConnect`'s result). When non-empty, the emitted block
   * gains an `env: { ATLAS_DEFAULT_WORKSPACE: <workspaceId> }` slot so
   * future MCP-client framework wrappers can bridge it into the
   * `X-Atlas-Default-Workspace` header (priority 2 in the edge's
   * resolution chain). Output matches the CLI's hosted-config writer
   * so SDK and CLI emit identical config blocks for the same token.
   *
   * **Wire-shape note.** [#2073's recommendation A](https://github.com/AtlasDevHQ/atlas/issues/2073)
   * sketched `url: "https://mcp.useatlas.dev/sse"` without a workspace
   * in the path, but the implemented hosted MCP endpoint mounts at
   * `/mcp/{workspace_id}/sse` and resolves per-request overrides via
   * the `X-Atlas-Workspace` header. The SDK emits the implemented
   * shape — a single config block, one default workspace in the
   * path, and the env hint for per-request overrides.
   *
   * Omit (or pass an empty array) for the legacy single-workspace
   * shape — backward-compatible with every caller pre-#2196.
   */
  workspaces?: ReadonlyArray<string>;
}

export interface McpHttpServer {
  url: string;
  headers: { Authorization: string };
  /**
   * Multi-workspace hint block (#2196). Present only when `buildConfig`
   * was called with a non-empty `workspaces` array — the legacy
   * single-workspace shape omits the field entirely so the
   * JSON-serialized server block is byte-identical to pre-#2196
   * output. (The outer `McpClientConfig` carries a `kind` discriminator
   * intended to be dropped before JSON output; see `stripKind` in the
   * worked example for the standard call-site pattern.)
   */
  env?: { ATLAS_DEFAULT_WORKSPACE: string };
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
  const apiUrl = stripTrailingSlashes(options.apiUrl);
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

  const apiUrl = stripTrailingSlashes(options.apiUrl);
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
    const workspaces = extractWorkspacesClaim(claims);

    const expiresIn =
      typeof tokenResponse.expires_in === "number" && tokenResponse.expires_in > 0
        ? tokenResponse.expires_in
        : 3600;

    return {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiresAt: Date.now() + expiresIn * 1000,
      workspaceId,
      workspaces,
    };
  });
}

// ── buildConfig ───────────────────────────────────────────────────────

const SERVER_NAME_DEFAULT = "atlas";

export function buildConfig(options: BuildConfigOptions): McpClientConfig {
  const apiUrl = stripTrailingSlashes(options.apiUrl);
  // workspaceId is opaque server-issued; encode it defensively so a
  // value containing path-sensitive characters can't reshape the URL.
  const url = `${apiUrl}/mcp/${encodeURIComponent(options.workspaceId)}/sse`;
  // Multi-workspace opt-in (#2196): non-empty `workspaces` emits the
  // env hint. Empty / omitted preserves the legacy single-workspace
  // shape. Loudly reject the embedder-error case where the picked
  // default isn't in the granted set — silently encoding a stale id
  // into the URL would surface as a generic 403 cross_workspace_denied
  // at runtime with no hint that the picker had a bad value.
  const isMultiWorkspace = (options.workspaces?.length ?? 0) > 0;
  if (isMultiWorkspace && !options.workspaces!.includes(options.workspaceId)) {
    throw new AtlasMcpError(
      `buildConfig: workspaceId \`${options.workspaceId}\` is not in the granted workspaces list — pass a default that is one of: ${options.workspaces!.join(", ")}.`,
      "workspace_not_in_grant_list",
    );
  }
  const block: McpHttpServer = isMultiWorkspace
    ? {
        url,
        headers: { Authorization: `Bearer ${options.accessToken}` },
        env: { ATLAS_DEFAULT_WORKSPACE: options.workspaceId },
      }
    : {
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
      return isMultiWorkspace
        ? {
            kind: "bare",
            url: block.url,
            headers: block.headers,
            env: block.env,
          }
        : { kind: "bare", url: block.url, headers: block.headers };
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

function stripTrailingSlashes(s: string): string {
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

/**
 * Extract the optional plural workspaces claim (#2196). Returns an
 * empty array when the claim is missing (single-workspace tokens omit
 * it) OR when the claim is present but malformed. Never throws — the
 * plural claim is informational, not a security boundary; falling back
 * to the singular workspace is always safe.
 *
 * Diagnostics: the missing-claim path is the documented common case for
 * single-workspace tokens and stays silent. The malformed paths
 * (non-array shape, or array with non-string entries) emit a
 * `console.warn` so a misconfigured self-hosted issuer that ships a
 * broken plural shape on every token surfaces in operator logs rather
 * than silently downgrading every user to single-workspace forever.
 * The matching CLI helper (`plugins/mcp/src/init/hosted.ts`) emits the
 * same diagnostics via its own logger seam — parity prevents the SDK
 * and CLI from diverging on which malformed inputs produce a signal.
 */
function extractWorkspacesClaim(payload: Record<string, unknown>): string[] {
  const raw = payload[WORKSPACES_CLAIM];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn(
      `[@useatlas/sdk] ${WORKSPACES_CLAIM} claim was present but not an array (got ${typeof raw}); falling back to single-workspace.`,
    );
    return [];
  }
  const filtered = raw.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (filtered.length !== raw.length) {
    const dropped = raw.length - filtered.length;
    console.warn(
      `[@useatlas/sdk] ${WORKSPACES_CLAIM} claim contained ${dropped} non-string or empty entr${dropped === 1 ? "y" : "ies"}; using only the ${filtered.length} valid entr${filtered.length === 1 ? "y" : "ies"}.`,
    );
  }
  return filtered;
}
