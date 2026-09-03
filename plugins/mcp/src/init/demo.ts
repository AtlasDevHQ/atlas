/**
 * `init --demo` flow: mint an anonymous demo principal against the hosted
 * NovaMart demo and return the bearer + endpoint to write into the client
 * config (#5604).
 *
 * No OAuth, no DCR, no browser, no account, no email. One POST to
 * `${apiUrl}/api/v1/demo/anonymous` returns a short-lived token scoped to the
 * demo workspace only; the MCP client then talks to `${apiUrl}/mcp/demo` with
 * it. The token is the only artifact written, inside the user's MCP client
 * config at mode 0o600, same as the hosted flow.
 *
 * Every external dependency is overrideable (`fetchImpl`) so the unit tests
 * never touch the network.
 */

import { OAuthHelperError, validateIssuerUrl } from "../_oauth-helper";

export type DemoFlowErrorCode =
  | "invalid_api_url"
  | "demo_disabled"
  | "rate_limited"
  | "mint_failed"
  | "malformed_response";

export class DemoFlowError extends Error {
  constructor(
    message: string,
    public readonly code: DemoFlowErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DemoFlowError";
  }
}

export interface DemoFlowOptions {
  /** Atlas API base — e.g. `https://mcp.useatlas.dev`. HTTPS, or loopback HTTP for local dev. */
  apiUrl: string;
  /** Free-text client label sent with the mint (counted server-side, never shown). */
  client?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface DemoFlowResult {
  /** The anonymous demo bearer. Treat as a credential for its (short) lifetime. */
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  sessionId: string;
  /** The one workspace this principal can reach. */
  workspaceId: string;
  /** `${apiUrl}/mcp/demo` — the Streamable HTTP endpoint to configure. */
  mcpUrl: string;
}

/** Drop trailing `/` characters. Non-regex to keep the polynomial-ReDoS checker happy. */
function stripTrailingSlashes(s: string): string {
  let i = s.length;
  while (i > 0 && s[i - 1] === "/") i--;
  return i === s.length ? s : s.slice(0, i);
}

interface MintErrorBody {
  error?: unknown;
  message?: unknown;
  retryAfterSeconds?: unknown;
  requestId?: unknown;
}

function describeFailure(body: MintErrorBody | null, status: number): string {
  const code = typeof body?.error === "string" ? body.error : `http_${status}`;
  const message = typeof body?.message === "string" ? body.message : "";
  const requestId = typeof body?.requestId === "string" ? ` (request id ${body.requestId})` : "";
  return `${code}${message ? `: ${message}` : ""}${requestId}`;
}

/**
 * Mint an anonymous demo principal. Pure data — the caller decides whether
 * to print or write the resulting config.
 */
export async function runDemoMintFlow(options: DemoFlowOptions): Promise<DemoFlowResult> {
  const apiUrl = stripTrailingSlashes(options.apiUrl);
  try {
    validateIssuerUrl(apiUrl);
  } catch (err) {
    if (err instanceof OAuthHelperError) {
      throw new DemoFlowError(err.message, "invalid_api_url", { cause: err });
    }
    throw err;
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${apiUrl}/api/v1/demo/anonymous`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(options.client ? { client: options.client } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DemoFlowError(`Could not reach ${apiUrl}: ${msg}`, "mint_failed", { cause: err });
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err) {
    // A non-JSON body on a failure is reported below by status alone; on a
    // 2xx it is a malformed response. Either way the parse error itself is
    // not the signal, so it is narrowed into the message rather than logged.
    const msg = err instanceof Error ? err.message : String(err);
    if (res.ok) {
      throw new DemoFlowError(`Demo mint returned a non-JSON body: ${msg}`, "malformed_response");
    }
  }

  if (!res.ok) {
    const errBody = (typeof body === "object" && body !== null ? body : null) as MintErrorBody | null;
    if (res.status === 404) {
      throw new DemoFlowError(
        `The anonymous demo is not enabled at ${apiUrl} (${describeFailure(errBody, res.status)}).`,
        "demo_disabled",
      );
    }
    if (res.status === 429) {
      const retry = typeof errBody?.retryAfterSeconds === "number" ? ` Retry in ${errBody.retryAfterSeconds}s.` : "";
      throw new DemoFlowError(`The demo is rate-limited right now.${retry}`, "rate_limited");
    }
    throw new DemoFlowError(
      `Demo mint failed at ${apiUrl} — ${describeFailure(errBody, res.status)}.`,
      "mint_failed",
    );
  }

  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const { token, expiresAt, sessionId, workspaceId, mcpUrl } = record;
  if (
    typeof token !== "string" || token.length === 0 ||
    typeof expiresAt !== "number" ||
    typeof sessionId !== "string" || sessionId.length === 0 ||
    typeof workspaceId !== "string" || workspaceId.length === 0 ||
    typeof mcpUrl !== "string" || mcpUrl.length === 0
  ) {
    throw new DemoFlowError(
      "Demo mint response was missing token, expiresAt, sessionId, workspaceId or mcpUrl.",
      "malformed_response",
    );
  }

  return { accessToken: token, expiresAt, sessionId, workspaceId, mcpUrl };
}
