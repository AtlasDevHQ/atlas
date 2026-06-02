/**
 * Transport core — POST a JSON payload to a webhook endpoint with bounded
 * retry, a per-attempt timeout, and a tagged delivery outcome.
 *
 * Framework-free by design: no Effect, no logger, no validation library. The
 * server consumers wrap the result in their own logging / Effect layer; the
 * plugin consumer (which has no Effect runtime) awaits it directly. The only
 * side-channel is the optional `onFailedAttempt` callback, so a caller can
 * emit retry breadcrumbs through whatever logger it has (structured logger on
 * the server, `console.warn` in the plugin).
 *
 * Retry policy is supplied explicitly as `{ maxAttempts, delaysMs }` — the
 * package never invents a backoff schedule behind the caller's back. Use
 * `cappedExponentialDelays` to build a capped exponential schedule.
 *
 * Failure classification (shared by every sender):
 *   2xx                  → ok, stop.
 *   4xx                  → permanent. The receiver rejected the payload;
 *                          retrying just spams them. Stop, read a bounded body
 *                          excerpt for diagnostics.
 *   5xx / transport / timeout → transient. Retry per the policy.
 */

import type { SignStrategy } from "./sign";

/** Injectable fetch — defaults to the global `fetch`. */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** Bounded retry schedule. */
export interface RetryPolicy {
  /** Total attempts including the first. Values < 1 are clamped to 1. */
  readonly maxAttempts: number;
  /**
   * Delay (ms) before each retry. `delaysMs[i]` is the wait after attempt
   * `i + 1`. If the schedule is shorter than the gaps, the last entry repeats;
   * an empty schedule means no wait between attempts.
   */
  readonly delaysMs: readonly number[];
}

/** Why a single attempt failed. */
export type AttemptFailure =
  | { readonly kind: "http_error"; readonly status: number; readonly responseText?: string }
  | { readonly kind: "transport_error"; readonly error: string };

/** Reported to `onFailedAttempt` after each failed attempt. */
export interface FailedAttempt {
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Whether the delivery will make a further attempt after this one. */
  readonly willRetry: boolean;
  readonly failure: AttemptFailure;
}

/**
 * Tagged delivery outcome. `signature` is always present (the value sent in
 * the signature header) so successful callers can surface it for audit.
 */
export type DeliveryOutcome =
  | {
      readonly kind: "ok";
      readonly status: number;
      readonly attempts: number;
      readonly signature: string;
    }
  | {
      readonly kind: "http_error";
      readonly status: number;
      readonly attempts: number;
      /** Normalized short code, e.g. `http_500`. */
      readonly error: string;
      /** Bounded body excerpt, read only for permanent (4xx) rejections. */
      readonly responseText?: string;
      readonly signature: string;
    }
  | {
      readonly kind: "transport_error";
      readonly attempts: number;
      readonly error: string;
      readonly signature: string;
    };

export interface DeliverWebhookOptions {
  /** Destination URL. Callers are responsible for https-only / SSRF posture. */
  readonly url: string;
  /** JSON-serializable payload. Stringified once; the same string is signed and sent. */
  readonly payload: unknown;
  /** Signing strategy (`timestamped` / `rawBody`). */
  readonly sign: SignStrategy;
  /** Retry schedule. Defaults to a single attempt with no retry. */
  readonly retry?: RetryPolicy;
  /** Per-attempt timeout via `AbortController`. Defaults to 30s. */
  readonly timeoutMs?: number;
  /** Injectable fetch — test seam. Defaults to the global `fetch`. */
  readonly fetcher?: Fetcher;
  /** Observe each failed attempt — e.g. emit a retry breadcrumb. */
  readonly onFailedAttempt?: (attempt: FailedAttempt) => void;
  /** Injectable sleep — test seam. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 1, delaysMs: [] };
const MAX_RESPONSE_EXCERPT = 200;

function defaultFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a bounded excerpt of an error response body. Best-effort: the status
 * code already carries the signal, so an unreadable body is not fatal.
 */
async function readExcerpt(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return text.length > MAX_RESPONSE_EXCERPT
      ? `${text.slice(0, MAX_RESPONSE_EXCERPT)}…`
      : text;
  } catch {
    // intentionally ignored: the body excerpt is a diagnostic breadcrumb, not
    // load-bearing — an already-consumed or closed stream just yields no text.
    return undefined;
  }
}

/**
 * Build a capped exponential backoff schedule: `delaysMs[i] = baseMs * factor^i`,
 * optionally clamped to `maxMs`. `count` is the number of gaps (usually
 * `maxAttempts - 1`).
 */
export function cappedExponentialDelays(opts: {
  readonly baseMs: number;
  readonly count: number;
  readonly factor?: number;
  readonly maxMs?: number;
}): number[] {
  const factor = opts.factor ?? 2;
  const delays: number[] = [];
  for (let i = 0; i < opts.count; i++) {
    const raw = opts.baseMs * factor ** i;
    delays.push(opts.maxMs !== undefined ? Math.min(raw, opts.maxMs) : raw);
  }
  return delays;
}

/**
 * Deliver one signed POST with bounded retry. Never throws for an expected
 * delivery failure — returns a tagged outcome the caller maps to its own
 * convention (the server logs it; the plugin re-throws on non-ok).
 */
export async function deliverWebhook(
  options: DeliverWebhookOptions,
): Promise<DeliveryOutcome> {
  const {
    url,
    payload,
    sign,
    retry = DEFAULT_RETRY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetcher = defaultFetch,
    onFailedAttempt,
    sleep = defaultSleep,
  } = options;

  const maxAttempts = Math.max(1, retry.maxAttempts);
  const body = JSON.stringify(payload);
  const { signature, headers } = sign(body);

  let lastFailure: AttemptFailure | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let permanent = false;
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: { ...headers },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        return { kind: "ok", status: res.status, attempts: attempt, signature };
      }
      if (res.status >= 400 && res.status < 500) {
        // Permanent — the receiver said no. Capture a body excerpt and stop.
        const responseText = await readExcerpt(res);
        lastFailure = { kind: "http_error", status: res.status, responseText };
        permanent = true;
      } else {
        lastFailure = { kind: "http_error", status: res.status };
      }
    } catch (err) {
      lastFailure = {
        kind: "transport_error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }

    const willRetry = !permanent && attempt < maxAttempts;
    onFailedAttempt?.({ attempt, maxAttempts, willRetry, failure: lastFailure });

    if (permanent) break;
    if (attempt < maxAttempts) {
      const wait =
        retry.delaysMs[attempt - 1] ??
        retry.delaysMs[retry.delaysMs.length - 1] ??
        0;
      await sleep(wait);
    }
  }

  // Exhausted retries or hit a permanent rejection.
  if (lastFailure?.kind === "http_error") {
    return {
      kind: "http_error",
      status: lastFailure.status,
      attempts: attemptsUsed,
      error: `http_${lastFailure.status}`,
      responseText: lastFailure.responseText,
      signature,
    };
  }
  return {
    kind: "transport_error",
    attempts: attemptsUsed,
    error: lastFailure?.error ?? "transport_error",
    signature,
  };
}
