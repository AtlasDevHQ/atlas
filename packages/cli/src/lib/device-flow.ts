/**
 * OAuth 2.0 device-authorization grant client (RFC 8628) for `atlas login`
 * (#4043 / ADR-0025).
 *
 * Talks to Better Auth's `deviceAuthorization` plugin endpoints under
 * `/api/auth/device/*`. Kept transport-thin and dependency-free: `fetch` and
 * `sleep` are injectable so the poll loop is unit-testable without real timers
 * or a live server.
 *
 *   1. `requestDeviceCode` → POST /api/auth/device/code  → user code + URL
 *   2. (human approves in the browser at the verification URL)
 *   3. `pollForToken`      → POST /api/auth/device/token → session bearer
 *
 * The returned bearer is a Better Auth SESSION token; the caller stores it via
 * the credential module and sends it as `Authorization: Bearer <token>`.
 */

/** The well-known public client id for the Atlas CLI (gh/railway model). */
export const ATLAS_CLI_CLIENT_ID = "atlas-cli";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface DeviceTokenResult {
  readonly token: string;
  readonly expiresIn: number | undefined;
}

/** A device-flow failure carrying the RFC 8628 error code (e.g. `access_denied`). */
export class DeviceFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

type FetchImpl = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Request a device + user code, initiating the flow. */
export async function requestDeviceCode(
  baseUrl: string,
  opts: { clientId: string; scope?: string; fetchImpl?: FetchImpl },
): Promise<DeviceCodeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        ...(opts.scope ? { scope: opts.scope } : {}),
      }),
    });
  } catch (err) {
    throw new DeviceFlowError(
      "network_error",
      `Could not reach the Atlas API at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // intentionally ignored: a non-JSON / empty body falls through to the
  // !res.ok / missing-field check below, which raises a DeviceFlowError.
  const body = asRecord(await res.json().catch(() => ({})));
  if (!res.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    const detail =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : `HTTP ${res.status}`;
    throw new DeviceFlowError("device_code_failed", `Failed to start device login: ${detail}`);
  }

  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: String(body.verification_uri ?? ""),
    verification_uri_complete:
      typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expires_in: typeof body.expires_in === "number" ? body.expires_in : 1800,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

/**
 * Poll the token endpoint until the human approves (returns the bearer),
 * denies / the code expires (throws a terminal {@link DeviceFlowError}), or
 * `maxAttempts` is exhausted (throws `timeout`). Honours `authorization_pending`
 * (keep polling) and `slow_down` (back off by 5s, per RFC 8628 §3.5).
 */
export async function pollForToken(
  baseUrl: string,
  opts: {
    clientId: string;
    deviceCode: string;
    intervalSeconds: number;
    fetchImpl?: FetchImpl;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    onPending?: () => void;
    onSlowDown?: (newIntervalSeconds: number) => void;
  },
): Promise<DeviceTokenResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 240;
  let interval = Math.max(1, opts.intervalSeconds);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(interval * 1000);

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/api/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: opts.deviceCode,
          client_id: opts.clientId,
        }),
      });
    } catch (err) {
      throw new DeviceFlowError(
        "network_error",
        `Lost contact with the Atlas API while waiting for approval: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // intentionally ignored: a non-JSON / empty body yields {} → no
    // access_token and no known `error` → the unknown_error terminal branch.
    const body = asRecord(await res.json().catch(() => ({})));

    if (typeof body.access_token === "string") {
      return {
        token: body.access_token,
        expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
      };
    }

    const code = typeof body.error === "string" ? body.error : "unknown_error";
    if (code === "authorization_pending") {
      opts.onPending?.();
      continue;
    }
    if (code === "slow_down") {
      interval += 5;
      opts.onSlowDown?.(interval);
      continue;
    }
    // Terminal: access_denied / expired_token / invalid_grant / invalid_request / server_error.
    throw new DeviceFlowError(
      code,
      terminalMessage(code, typeof body.error_description === "string" ? body.error_description : undefined),
    );
  }

  throw new DeviceFlowError(
    "timeout",
    "Timed out waiting for device approval. Run `atlas login` again.",
  );
}

function terminalMessage(code: string, description: string | undefined): string {
  switch (code) {
    case "access_denied":
      return "The login request was denied in the browser.";
    case "expired_token":
      return "The login code expired before it was approved. Run `atlas login` again.";
    default:
      return description ?? `Device authorization failed (${code}).`;
  }
}
