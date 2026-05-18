/**
 * Proactive-chat enterprise gate — slice 10/11 of #2017 (#2572).
 *
 * Replaces the four `requireEnterpriseEffect("proactive-chat")` calls in
 * `packages/api/src/api/routes/admin-proactive*.ts`. EE always reports
 * `enabled: true` from the perspective of the gate (the route's caller
 * still has to be authorized to reach the admin router); the no-op
 * default in `lib/effect/services.ts:NoopProactiveGateLayer` fails with
 * `EnterpriseError` so non-enterprise tenants see 403
 * `enterprise_required` and route through `EnterpriseUpsell` /
 * `<FeatureGate feature="Proactive Chat">`.
 *
 * `requireEnabled` re-reads `isEnterpriseEnabled()` on every call so a
 * runtime flip of `ATLAS_ENTERPRISE_ENABLED` propagates without
 * restart — same semantics as the original
 * `requireEnterpriseEffect("proactive-chat")` it replaces.
 */

import { Effect, Layer } from "effect";
import { isEnterpriseEnabled, EnterpriseError } from "./index";
import {
  ProactiveGate,
  type ProactiveGateShape,
} from "@atlas/api/lib/effect/services";

export const makeProactiveGateLive = (): ProactiveGateShape => ({
  enabled: true,
  requireEnabled: () =>
    isEnterpriseEnabled()
      ? Effect.void
      : Effect.fail(
          new EnterpriseError(
            "Enterprise features (proactive-chat) are not enabled. " +
              "Set ATLAS_ENTERPRISE_ENABLED=true or configure enterprise.enabled in atlas.config.ts.",
          ),
        ),
});

export const ProactiveGateLive: Layer.Layer<ProactiveGate> = Layer.sync(
  ProactiveGate,
  makeProactiveGateLive,
);
