/**
 * Permanence-classification policy unit tests for the delivery-transport
 * seam (#4198) — one suite per channel descriptor.
 *
 * The shared {@link deliverVia} wrapper owns the load → send → classify →
 * log → DeliveryError skeleton; the ONLY per-channel policy is what counts
 * as a permanent failure. These tests pin that policy per channel:
 *   - email:   `provider === "log"` (no sender configured)
 *   - slack:   missing bot token; API `ok: false` stays transient
 *   - webhook: blocked URL (pre-flight + egress guard) and HTTP 4xx
 */
import { describe, it, expect, mock } from "bun:test";
import { EgressBlockedError } from "@atlas/api/lib/openapi/egress-guard";
import type { FormattedResult } from "../shape-result";
import {
  emailTransport,
  slackTransport,
  webhookTransport,
  isHttpPermanent,
  MissingSlackTokenError,
  BlockedWebhookUrlError,
} from "../delivery";

const shaped: FormattedResult = {
  taskId: "task-123",
  taskName: "Daily Revenue",
  question: "What was yesterday's revenue?",
  answer: "Revenue was $1M",
  sql: [],
  datasets: [],
  steps: 1,
  totalTokens: 10,
  generatedAt: "2024-01-01T00:00:00Z",
  orgId: null,
};

describe("email transport permanence policy", () => {
  const transport = emailTransport({ type: "email", address: "a@example.com" }, shaped);

  it("classifies the log-provider fallback as permanent (#3379)", async () => {
    const failure = await transport.inspect({
      success: false,
      provider: "log",
      error: "No email delivery backend configured — set RESEND_API_KEY",
    });
    expect(failure).toMatchObject({
      permanent: true,
      message: "No email delivery backend configured — set RESEND_API_KEY",
    });
  });

  it("classifies a real-provider failure as transient", async () => {
    const failure = await transport.inspect({ success: false, provider: "resend", error: "rate limited" });
    expect(failure).toMatchObject({ permanent: false, message: "rate limited" });
  });

  it("falls back to a generic message when the provider reports none", async () => {
    const failure = await transport.inspect({ success: false, provider: "resend" });
    expect(failure?.message).toBe("Email delivery failed");
  });

  it("treats a successful outcome as no failure", async () => {
    expect(await transport.inspect({ success: true, provider: "resend" })).toBeNull();
  });
});

describe("slack transport permanence policy", () => {
  const transport = slackTransport({ type: "slack", channel: "#reports" }, shaped);

  it("rejects with the missing-token sentinel before calling the API", async () => {
    const postMessage = mock(() => Promise.resolve({ ok: true as const }));
    await expect(
      transport.send({ token: null, postMessage: postMessage as never }),
    ).rejects.toBeInstanceOf(MissingSlackTokenError);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("classifies a missing bot token as permanent with a warn-level log", () => {
    const failure = transport.classifyThrown?.(new MissingSlackTokenError());
    expect(failure).toMatchObject({ permanent: true, message: "No Slack bot token" });
    expect(failure?.log?.level).toBe("warn");
  });

  it("leaves other thrown errors to the default transient classification", () => {
    expect(transport.classifyThrown?.(new Error("ECONNRESET"))).toBeNull();
  });

  it("classifies an API-level error as transient", async () => {
    const failure = await transport.inspect({ ok: false, error: "channel_not_found" });
    expect(failure).toMatchObject({ permanent: false, message: "channel_not_found" });
  });

  it("treats an ok response as no failure", async () => {
    expect(await transport.inspect({ ok: true })).toBeNull();
  });
});

describe("webhook transport permanence policy", () => {
  const transport = webhookTransport({ type: "webhook", url: "https://hook.example.com" }, shaped);

  it("rejects a blocked URL with the sentinel before any fetch", async () => {
    const blocked = webhookTransport({ type: "webhook", url: "http://10.0.0.1/internal" }, shaped);
    const fetchImpl = mock(() => Promise.resolve(new Response("ok")));
    await expect(blocked.send(fetchImpl as never)).rejects.toBeInstanceOf(BlockedWebhookUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies a pre-flight blocked URL as permanent", () => {
    const failure = transport.classifyThrown?.(new BlockedWebhookUrlError());
    expect(failure).toMatchObject({ permanent: true, message: "Blocked URL" });
  });

  it("classifies an egress-guard rejection (redirect hop) as permanent (#3340)", () => {
    const failure = transport.classifyThrown?.(new EgressBlockedError("http://169.254.169.254/latest"));
    expect(failure?.permanent).toBe(true);
    expect(failure?.message).toContain("Blocked URL (egress guard)");
  });

  it("leaves network errors to the default transient classification", () => {
    expect(transport.classifyThrown?.(new Error("network error"))).toBeNull();
  });

  it("classifies HTTP 4xx as permanent and 5xx as transient", async () => {
    const notFound = await transport.inspect(new Response("nope", { status: 404 }));
    expect(notFound).toMatchObject({ permanent: true, message: "HTTP 404" });

    const serverError = await transport.inspect(new Response("boom", { status: 500 }));
    expect(serverError).toMatchObject({ permanent: false, message: "HTTP 500" });
  });

  it("treats a 2xx response as no failure", async () => {
    expect(await transport.inspect(new Response("ok", { status: 200 }))).toBeNull();
  });
});

describe("isHttpPermanent", () => {
  it("marks exactly the 4xx range permanent", () => {
    expect(isHttpPermanent(399)).toBe(false);
    expect(isHttpPermanent(400)).toBe(true);
    expect(isHttpPermanent(499)).toBe(true);
    expect(isHttpPermanent(500)).toBe(false);
  });
});
