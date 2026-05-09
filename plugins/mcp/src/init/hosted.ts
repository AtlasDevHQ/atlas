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
 * ── Where the protocol lives ───────────────────────────────────────────
 *
 * Discovery, DCR, PKCE, authorization-URL construction, token exchange,
 * the HTTPS-only token-endpoint guard (#2198), JWT-payload decode, and
 * issuer enforcement are all in `@atlas/oauth-helper` — vendored into
 * `./_oauth-helper/` at install time so the published `@useatlas/mcp`
 * carries a self-contained copy. This file owns the loopback transport
 * (browser launch, listener, callback resolver, plural-claim extraction)
 * and translates helper errors into `HostedFlowError` for the CLI's
 * exit-code mapping. Spec quirks and security hardenings land in the
 * helper once and reach both `@useatlas/sdk` and `@useatlas/mcp` at the
 * same time.
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
} from "../_oauth-helper";

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
  /**
   * The `https://atlas.useatlas.dev/workspace_ids` plural claim (#2073),
   * if present in the JWT. Atlas mints this for users belonging to more
   * than one workspace; the CLI uses it to decide whether to prompt for
   * single-vs-multi-workspace setup at write time. Empty array (or
   * missing claim) means single-workspace user — no prompt.
   */
  workspaceIds: string[];
  /** `${apiUrl}/mcp/${workspaceId}/sse` — what the MCP client connects to. */
  mcpUrl: string;
}

// ── Errors ─────────────────────────────────────────────────────────────

/**
 * Stable error code for tests + exit-code mapping. The first ten values
 * are 1:1 with `@atlas/oauth-helper`'s `OAuthHelperErrorCode` (the
 * helper layer maps to `invalid_token_endpoint` — new in #2203 — and
 * to the eight protocol primitives' codes; the CLI surfaces all of
 * them under `HostedFlowError` so the exit-code switch in
 * `bin/cli.ts` and the existing test suite continue to operate on a
 * single union). The remaining values are loopback / browser / callback
 * codes the CLI alone produces.
 */
export type HostedFlowErrorCode =
  | "invalid_api_url"
  | "invalid_token_endpoint"
  | "discovery_failed"
  | "issuer_mismatch"
  | "registration_failed"
  | "token_exchange_failed"
  | "malformed_jwt"
  | "missing_workspace_claim"
  | "loopback_bind_failed"
  | "browser_failed"
  | "callback_timeout"
  | "callback_state_mismatch"
  | "callback_missing_code"
  | "callback_oauth_error"
  | "callback_method_not_allowed";

export class HostedFlowError extends Error {
  constructor(
    message: string,
    public readonly code: HostedFlowErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostedFlowError";
  }
}

/**
 * Re-throw any `OAuthHelperError` as a `HostedFlowError` carrying the
 * same code. The helper's codes are a strict subset of
 * `HostedFlowErrorCode`, so the cast is safe — the exhaustive union
 * above is the compile-time witness. Other throws propagate untouched.
 */
async function liftHelper<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuthHelperError) {
      throw new HostedFlowError(err.message, err.code as HostedFlowErrorCode, {
        cause: err,
      });
    }
    throw err;
  }
}

function liftHelperSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OAuthHelperError) {
      throw new HostedFlowError(err.message, err.code as HostedFlowErrorCode, {
        cause: err,
      });
    }
    throw err;
  }
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const REQUESTED_SCOPES: ReadonlyArray<string> = [
  "openid",
  "profile",
  "email",
  "mcp:read",
  "offline_access",
];
const CLIENT_NAME = "Atlas MCP CLI";
const WORKSPACE_CLAIM = "https://atlas.useatlas.dev/workspace_id";
const WORKSPACES_CLAIM = "https://atlas.useatlas.dev/workspace_ids";

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
  liftHelperSync(() => validateIssuerUrl(apiUrl));
  const fetchImpl = options.fetchImpl ?? fetch;
  const serveImpl = options.serveImpl ?? defaultServeImpl;
  const openBrowserImpl = options.openBrowserImpl ?? defaultOpenBrowserImpl;
  const randomBytesImpl = options.randomBytesImpl;
  const cli: ConsoleImpl = options.consoleImpl ?? {
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
  const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Step 1 — discovery
  const metadata = await liftHelper(() => discover(apiUrl, { fetchImpl }));

  // Step 2 — generate PKCE + state and start the loopback listener BEFORE
  // registering, so we know the redirect_uri the OS picked. RFC 8252
  // §7.3 says clients SHOULD bind to 127.0.0.1 with port 0 and use
  // whatever port they get back.
  const state = generateState({ randomBytesImpl });
  const { codeVerifier, codeChallenge } = await generatePkce({ randomBytesImpl });

  const callbackResolver = createCallbackResolver(state, timeoutMs);
  // intentionally ignored: the outer `finally` calls `cancel()`, which
  // settles the resolver as a typed rejection. Whenever the outer flow
  // already failed via a different throw path (register/exchange/etc.)
  // that cancel-rejection becomes orphaned. The real error is surfaced
  // by the throw above; this `.catch` only silences Node's unhandled-
  // rejection warning for the abort path.
  callbackResolver.promise.catch(() => {});

  let server: LoopbackServer | undefined;
  try {
    server = await serveImpl(callbackResolver.handler);
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;

    // Step 3 — register a public client via DCR
    const clientId = await liftHelper(() =>
      register(
        metadata,
        {
          redirectUri,
          clientName: CLIENT_NAME,
          scopes: REQUESTED_SCOPES,
        },
        { fetchImpl },
      ),
    );

    // Step 4 — open the browser. Failure is non-fatal: print the URL
    // (already printed before the launch attempt) and continue waiting.
    // In headless / CI shells the user will hit `callback_timeout`
    // instead — the message there links back to the printed URL above.
    const authorizeUrl = buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId,
      redirectUri,
      state,
      codeChallenge,
      scopes: REQUESTED_SCOPES,
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

    // Step 6 — exchange the code. The helper validates the token
    // endpoint as https-or-loopback (#2198 hardening) before posting,
    // so a malicious DCR response advertising `token_endpoint:
    // "http://evil/token"` cannot smuggle the auth code over plaintext
    // — that protection now reaches the CLI for free as part of #2203.
    const tokenResponse = await liftHelper(() =>
      exchangeCode(
        {
          tokenEndpoint: metadata.token_endpoint,
          clientId,
          redirectUri,
          code,
          codeVerifier,
        },
        { fetchImpl },
      ),
    );

    // Step 7 — extract + verify claims. We don't verify the JWT
    // signature (the hosted MCP endpoint re-verifies on every request via
    // JWKS) but we DO check `iss` matches the issuer we discovered, so a
    // hostile auth server pretending to be Atlas can't slip a token past
    // us at write-time.
    const claims = liftHelperSync(() =>
      decodeJwtPayload(tokenResponse.access_token),
    );
    liftHelperSync(() => enforceIssuer(claims, metadata.issuer));
    const workspaceId = extractWorkspaceClaim(claims);
    const workspaceIds = extractWorkspacesClaim(claims);

    return {
      accessToken: tokenResponse.access_token as Bearer,
      refreshToken: tokenResponse.refresh_token
        ? (tokenResponse.refresh_token as Bearer)
        : null,
      workspaceId,
      workspaceIds,
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

// ── Workspace-claim extraction (CLI-specific — not in the helper) ──────

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

/**
 * Extract the optional plural workspace claim (#2073). Returns an empty
 * array when the claim is missing, malformed, or contains non-string
 * entries. Unlike the singular claim, this one is OPTIONAL — Atlas only
 * mints it for users belonging to more than one workspace, so its
 * absence is the common case (single-workspace users) and not a fatal
 * error. Malformed values silently degrade to empty rather than
 * `missing_workspace_claim`, since the CLI's worst case under "no plural
 * claim" is "skip the prompt" — strictly safer than failing the install.
 */
function extractWorkspacesClaim(payload: Record<string, unknown>): string[] {
  const raw = payload[WORKSPACES_CLAIM];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
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
      // User-agents only ever fetch the redirect URI as GET on completion
      // of the authorization step; anything else is an attempt to inject
      // parameters out-of-band. Reject without settling so a probe can't
      // preempt the legitimate callback.
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
 * Default loopback listener — Bun.serve on 127.0.0.1:0. The handler is
 * single-shot; subsequent requests get a 404 (see the inline comment
 * below for why 404 instead of 410). Exported so the test suite can
 * exercise the once-fired guard without re-binding through the public
 * `runHostedAuthFlow` entry point.
 */
export const defaultServeImpl: ServeImpl = async (handler) => {
  // Once-fired guard. The legitimate auth code is single-use server-side,
  // so any second hit on the redirect URI is either a stray browser
  // refresh or a fingerprinting probe — refuse either way.
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
      await server.stop(true);
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
  const helper = platform === "darwin" ? "open"
    : platform === "win32" ? "cmd /c start"
    : "xdg-open";
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
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        detail:
          platform === "linux"
            ? `${helper} not found on PATH — install xdg-utils (e.g. apt install xdg-utils) or open the URL above manually`
            : `${helper} not found on PATH — open the URL above manually`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
};
