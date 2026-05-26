/**
 * Cloudflare Turnstile siteverify wrapper.
 *
 * Why Turnstile and not Vercel BotID: apps/www is hosted on Railway
 * BEHIND Cloudflare. Cloudflare Turnstile is the natural bot-protection
 * fit — Vercel BotID requires the page to be served from Vercel.
 *
 * Contract (per Cloudflare docs —
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/):
 *   POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: secret=<TURNSTILE_SECRET_KEY>&response=<token>&remoteip=<ip?>
 *   Response: { success: boolean, "error-codes": string[], ... }
 *
 * Failure modes:
 *   - TURNSTILE_SECRET_KEY unset: we fail-closed by returning
 *     `{ ok: false, reason: "no_secret" }` — the operator should see
 *     this surfaced as the 403 envelope from the route handler. The
 *     alternative (fail-open) would let bot submissions through any
 *     SaaS deployment where the env var was accidentally unset, which
 *     is exactly what Turnstile exists to prevent.
 *   - Network / 5xx from siteverify: returned as `ok: false` so the
 *     client retries. Cloudflare's endpoint is generally <1% downtime,
 *     and a real outage would degrade the form to zero submissions —
 *     acceptable vs. accepting unverified traffic.
 *   - 2xx with `success: false`: returned as `ok: false` along with the
 *     `error-codes` array so the route logs them for debugging.
 */

import { createLogger } from "./logger";

const log = createLogger("turnstile");

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface VerifyTurnstileOptions {
  /** Token produced by the client-side Turnstile widget. */
  readonly token: string;
  /** Client IP. Optional — Cloudflare's docs say best-effort but recommended. */
  readonly remoteIp?: string | null;
  /** Request correlation id for log emission. */
  readonly requestId?: string;
  /** Override the fetch impl in tests. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Override the timeout in tests. */
  readonly timeoutMs?: number;
}

export type VerifyTurnstileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Cloudflare-returned codes (`["invalid-input-response", ...]`). */
      readonly errorCodes: readonly string[];
      /** Short reason string for log correlation when codes are absent. */
      readonly reason: string;
    };

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint.
 * Returns `{ ok: true }` only when Cloudflare returns 2xx with
 * `success: true`. Every other outcome (missing secret, network error,
 * non-2xx, `success: false`) returns `ok: false` with diagnostics.
 *
 * Never throws — the caller doesn't need to wrap in try/catch.
 */
export async function verifyTurnstile(
  opts: VerifyTurnstileOptions,
): Promise<VerifyTurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Fail-closed: bot-protection that silently lets everything through
    // because of a config mistake is a worse outcome than 100% rejection.
    // The route surfaces this as a 403 so operators see traffic stop.
    log.error(
      { requestId: opts.requestId, event: "turnstile.no_secret" },
      "TURNSTILE_SECRET_KEY is not set — failing siteverify closed. Set TURNSTILE_SECRET_KEY in the API env.",
    );
    return { ok: false, errorCodes: [], reason: "no_secret" };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // URLSearchParams keeps secret-key encoding consistent with Cloudflare's
  // expectations (form-encoded, not JSON) and avoids any manual escaping
  // pitfalls. Tokens contain `.` and `_` only, but a future format change
  // is one fewer thing to worry about.
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", opts.token);
  if (opts.remoteIp && opts.remoteIp.length > 0) {
    form.set("remoteip", opts.remoteIp);
  }

  let response: Response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = `siteverify_request_failed: ${err instanceof Error ? err.message : String(err)}`;
    // Log transport-level failures so call sites that don't surface the
    // returned reason (future ones, batch jobs, etc.) don't lose all
    // signal that Cloudflare's endpoint is unreachable. The contact
    // route surfaces this as a 403 + structured `turnstile_failed` log,
    // but the wrapper logs in its own right.
    log.warn(
      { requestId: opts.requestId, err: reason, event: "turnstile.network_failure" },
      "Turnstile siteverify request failed at the transport layer",
    );
    return { ok: false, errorCodes: [], reason };
  }

  if (!response.ok) {
    // Capture the Cloudflare error body (up to ~200 chars) so operators
    // can diagnose without reproducing — 4xx commonly carries a JSON
    // body explaining the misconfigured secret/sitekey.
    let bodyExcerpt = "";
    try {
      const raw = await response.text();
      bodyExcerpt = raw.slice(0, 200);
    } catch {
      // Reading the body is best-effort diagnostic context — a body
      // that can't be read is not itself a failure beyond the HTTP
      // status we already have.
    }
    return {
      ok: false,
      errorCodes: [],
      reason: bodyExcerpt
        ? `siteverify_http_${response.status}: ${bodyExcerpt}`
        : `siteverify_http_${response.status}`,
    };
  }

  let body: { success?: boolean; "error-codes"?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (err) {
    return {
      ok: false,
      errorCodes: [],
      reason: `siteverify_parse_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (body.success === true) return { ok: true };

  const rawCodes = body["error-codes"];
  const errorCodes = Array.isArray(rawCodes)
    ? rawCodes.filter((c): c is string => typeof c === "string")
    : [];
  return {
    ok: false,
    errorCodes,
    reason: errorCodes.length > 0 ? "siteverify_rejected" : "siteverify_no_success",
  };
}
