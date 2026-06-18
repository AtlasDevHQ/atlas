import { describe, it, expect } from "bun:test";
import { buildStripeWebhookSpanAttributes } from "../server";

/**
 * Tests for the `stripe.webhook.process` span attribute builder (#3684).
 *
 * The classify→sync→record sequence under `withStripeSubscriptionLock` is
 * wrapped in `withSpan` so slow processing (multi-second advisory-lock waits,
 * tier-write failures → 400 → Stripe retry storm) is attributable in traces.
 * Capturing live spans would mean wiring an `InMemorySpanExporter` — heavier
 * than the typo it would catch — so the pure attribute builder is the
 * load-bearing piece under test (the applied-tier result attribute and no-op
 * wrap behaviour are exercised by `stripe-webhook-lifecycle.test.ts` and
 * `tracing.test.ts` respectively).
 */
describe("buildStripeWebhookSpanAttributes", () => {
  it("emits event id + type, and the subscription id when present", () => {
    expect(
      buildStripeWebhookSpanAttributes({
        eventId: "evt_123",
        eventType: "customer.subscription.updated",
        subscriptionId: "sub_456",
      }),
    ).toEqual({
      "stripe.event_id": "evt_123",
      "stripe.event_type": "customer.subscription.updated",
      "stripe.subscription_id": "sub_456",
    });
  });

  it("omits the subscription id for an event with no subscription (e.g. null)", () => {
    expect(
      buildStripeWebhookSpanAttributes({
        eventId: "evt_789",
        eventType: "checkout.session.completed",
        subscriptionId: null,
      }),
    ).toEqual({
      "stripe.event_id": "evt_789",
      "stripe.event_type": "checkout.session.completed",
    });
  });
});
