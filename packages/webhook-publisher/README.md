# @useatlas/webhook-publisher

Framework-free outbound webhook sender for [Atlas](https://www.useatlas.dev) —
pluggable HMAC signing strategies + bounded retry with a tagged delivery
outcome.

It's the one primitive behind Atlas's outbound senders (the sub-processor
change feed, SLA alerts, and the `@useatlas/webhook-action` plugin), so signing
and retry behave identically everywhere and no consumer's on-the-wire format
drifts.

No dependencies. No Effect, no logger, no validation library — just `fetch` and
`node:crypto`. The server wraps the result in its structured logger; the plugin
(which has no Effect runtime) awaits it directly.

## Install

```bash
bun add @useatlas/webhook-publisher
```

## Usage

```ts
import {
  deliverWebhook,
  timestamped,
  cappedExponentialDelays,
} from "@useatlas/webhook-publisher";

const outcome = await deliverWebhook({
  url: "https://hooks.example.com/atlas",
  payload: { event: "added", entry },
  sign: timestamped({ secret: process.env.WEBHOOK_SECRET! }),
  retry: { maxAttempts: 3, delaysMs: cappedExponentialDelays({ baseMs: 1000, count: 2 }) },
  timeoutMs: 10_000,
});

switch (outcome.kind) {
  case "ok":
    break; // delivered; outcome.signature is the header value, for audit
  case "http_error":
    console.warn(`rejected: HTTP ${outcome.status} after ${outcome.attempts} attempts`);
    break;
  case "transport_error":
    console.warn(`unreachable: ${outcome.error} after ${outcome.attempts} attempts`);
    break;
}
```

## Signing strategies

Both are pure functions of the serialized body. `deliverWebhook` signs the body
once and reuses the headers across retries, so a timestamp (when present) is
stable for the whole delivery.

### `timestamped({ secret, timestampSeconds? })` — Atlas house standard

```
X-Webhook-Signature: sha256=<hmac(`${ts}:${body}`)>
X-Webhook-Timestamp: <unix-seconds>
```

The `sha256=` prefix is Stripe/GitHub style, and this is byte-identical to
Atlas's existing sub-processor sender. The `${ts}:${body}` signing input matches
the inbound `@useatlas/webhook` verifier, but that verifier compares against
**bare hex** — so receivers strip the `sha256=` prefix first, as the
verify-helper below (and the one in the sub-processor docs) does.

**Verify recipe (receiver):**

```ts
import crypto from "node:crypto";

function verify(secret: string, header: string, timestamp: string, rawBody: string): boolean {
  // Reject requests older than 5 minutes to block replays.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}:${rawBody}`).digest("hex");
  const provided = header.replace(/^sha256=/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

### `rawBody({ secret })` — Stripe/GitHub style

```
X-Atlas-Signature: <hmac(rawBody)>
```

Bare hex over the exact request body, no timestamp.

```ts
const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
// constant-time compare expected against the X-Atlas-Signature header
```

## Retry & failure classification

Retry is supplied explicitly — the package never invents a backoff schedule:

```ts
retry: { maxAttempts: 4, delaysMs: [250, 1000, 4000] }
```

- `2xx` → `ok`, stop.
- `4xx` → **permanent**. The receiver rejected the payload; retrying just spams
  them. Stops and reads a bounded body excerpt (`responseText`).
- `5xx` / transport error / timeout → **transient**. Retried per the policy.

`cappedExponentialDelays({ baseMs, count, factor?, maxMs? })` builds a capped
exponential schedule. Each attempt has its own `timeoutMs` (default 30s) via
`AbortController`. Pass `onFailedAttempt` to emit a breadcrumb per failed
attempt, and `fetcher` / `sleep` to inject test seams.

## License

MIT
