/**
 * Pure-helper + delivery tests for the sub-processor change-feed publisher.
 *
 * The DB-bound `subProcessorPublisherTick` is exercised in
 * `sub-processor-publisher-tick.test.ts` (snapshot/diff/fan-out
 * orchestration). This file focuses on the pieces that are easiest to
 * reason about in isolation: hashing, diffing, HMAC signing, retry
 * semantics, and the decrypt-failure re-throw contract.
 */

import { describe, it, expect, mock } from "bun:test";
import crypto from "crypto";

import {
  computeDiff,
  deliver,
  hashPayload,
  signRequest,
  type ChangeEvent,
  type Fetcher,
  type SubProcessor,
  type SubscriptionRow,
} from "@atlas/api/lib/sub-processor-publisher";

const A: SubProcessor = {
  name: "Vercel",
  purpose: "AI Gateway",
  region: "United States",
  since: "2026-01",
  changed_at: "2026-01-15",
};

const B: SubProcessor = {
  name: "Anthropic",
  purpose: "Hosted model inference",
  region: "United States",
  since: "2026-01",
  changed_at: "2026-01-15",
};

describe("hashPayload", () => {
  it("is order-independent", () => {
    expect(hashPayload([A, B])).toBe(hashPayload([B, A]));
  });

  it("changes when any field changes", () => {
    const variant = { ...A, region: "European Union" };
    expect(hashPayload([A])).not.toBe(hashPayload([variant]));
  });
});

describe("computeDiff", () => {
  it("emits added for entries new in `next`", () => {
    const events = computeDiff([A], [A, B]);
    expect(events).toEqual([{ event: "added", entry: B }]);
  });

  it("emits removed for entries missing from `next`", () => {
    const events = computeDiff([A, B], [A]);
    expect(events).toEqual([{ event: "removed", entry: B }]);
  });

  it("emits changed when purpose, region, or changed_at differ", () => {
    const updatedRegion = { ...A, region: "European Union" };
    const events = computeDiff([A], [updatedRegion]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "changed",
      entry: updatedRegion,
      previous: A,
    });
  });

  it("does not emit on identity", () => {
    expect(computeDiff([A, B], [A, B])).toEqual([]);
  });
});

describe("signRequest", () => {
  const TOKEN = "shared-secret-at-least-16-chars";

  it("formats the digest as `sha256=<hex>` (Stripe/GitHub-style) over `${ts}:${body}`", () => {
    const ts = 1700000000;
    const payload = { event: "added", entry: A };
    const signed = signRequest(payload, TOKEN, ts);

    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", TOKEN)
        .update(`${ts}:${JSON.stringify(payload)}`)
        .digest("hex");

    expect(signed.signature).toBe(expected);
    expect(signed.headers["X-Webhook-Timestamp"]).toBe(String(ts));
    expect(signed.headers["X-Webhook-Signature"]).toBe(expected);
    expect(signed.headers["Content-Type"]).toBe("application/json");
  });

  it("produces a verifiable digest when the receiver runs the same algorithm", () => {
    const payload = { event: "removed", entry: B };
    const signed = signRequest(payload, TOKEN, 1700000001);

    // Receiver-side verification using the canonical algorithm.
    const candidate =
      "sha256=" +
      crypto
        .createHmac("sha256", TOKEN)
        .update(`${signed.timestamp}:${signed.body}`)
        .digest("hex");

    expect(candidate).toBe(signed.signature);
  });
});

describe("deliver", () => {
  // Tests pass an unprefixed token because in the test env (no
  // ATLAS_ENCRYPTION_KEYS configured) `decryptSecret` is a pass-through.
  // The encryption round-trip is covered separately in
  // `create-subscription-encryption.test.ts`.
  const SUB: SubscriptionRow = {
    id: "sub-1",
    url: "https://hooks.example.com/sub-processors",
    token_encrypted: "test-token-at-least-16-chars",
  };
  const EVENT: ChangeEvent = { event: "added", entry: A };

  it("returns kind=ok and stops retrying on the first 2xx", async () => {
    const fetcher = mock(async () => new Response(null, { status: 200 }));
    const result = await deliver(SUB, EVENT, { fetcher: fetcher as Fetcher });
    expect(result).toMatchObject({
      kind: "ok",
      status: 200,
      attempts: 1,
      subscriptionId: "sub-1",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 4xx — the receiver said no, retrying spams them", async () => {
    const fetcher = mock(async () => new Response("bad", { status: 400 }));
    const result = await deliver(SUB, EVENT, { fetcher: fetcher as Fetcher });
    expect(result.kind).toBe("http_error");
    if (result.kind === "http_error") {
      expect(result.status).toBe(400);
      expect(result.attempts).toBe(1);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx up to the configured max", async () => {
    let calls = 0;
    const fetcher = mock(async () => {
      calls++;
      return new Response("upstream", { status: 502 });
    });
    const result = await deliver(SUB, EVENT, { fetcher: fetcher as Fetcher });
    expect(result.kind).toBe("http_error");
    if (result.kind === "http_error") {
      expect(result.attempts).toBe(3);
      expect(result.status).toBe(502);
    }
    expect(calls).toBe(3);
  });

  it("signs each attempt with the decrypted token", async () => {
    let captured: { headers?: Record<string, string>; body?: string } = {};
    const fetcher = mock(async (_url: string, init: RequestInit) => {
      captured = {
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      };
      return new Response(null, { status: 200 });
    });
    await deliver(SUB, EVENT, { fetcher: fetcher as Fetcher, nowSeconds: 1700000002 });

    expect(captured.headers?.["X-Webhook-Timestamp"]).toBe("1700000002");
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", SUB.token_encrypted)
        .update(`1700000002:${captured.body}`)
        .digest("hex");
    expect(captured.headers?.["X-Webhook-Signature"]).toBe(expected);
  });

  it("re-throws when the token cannot be decrypted (config emergency, not a delivery hiccup)", async () => {
    // A token shaped like an `enc:vN:` envelope but referencing an
    // unknown key version triggers `decryptSecret` to throw.
    const broken: SubscriptionRow = {
      id: "sub-broken",
      url: "https://hooks.example.com/sp",
      // valid envelope shape with a key version that doesn't exist
      token_encrypted: "enc:v999:Zg==:Zg==:Zg==",
    };
    const fetcher = mock(async () => new Response(null, { status: 200 }));
    await expect(
      deliver(broken, EVENT, { fetcher: fetcher as Fetcher }),
    ).rejects.toThrow();
    // Decrypt failure must not even attempt delivery.
    expect(fetcher).not.toHaveBeenCalled();
  });
});
