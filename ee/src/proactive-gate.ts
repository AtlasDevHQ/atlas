/**
 * Proactive-chat availability gate — slice 10/11 of #2017 (#2572).
 *
 * Replaces the four `requireEnterpriseEffect("proactive-chat")` calls in
 * `packages/api/src/api/routes/admin-proactive*.ts`. The no-op default
 * in `lib/effect/services.ts:NoopProactiveGateLayer` fails with
 * `EnterpriseError` so denied tenants see 403 `enterprise_required` and
 * route through `EnterpriseUpsell` / `<FeatureGate feature="Proactive Chat">`.
 *
 * **Proactive is a hosted-SaaS-only feature (#3999).** The gate keys on
 * `resolveDeployMode() === "saas"`, not `isEnterpriseEnabled()`: it is denied on
 * every self-hosted deployment, *including self-hosted enterprise*, so proactive
 * is no longer a self-hostable `ee/` capability. (On SaaS, `resolveDeployMode`
 * already requires enterprise to be enabled, so the prior enterprise condition
 * is subsumed.) Within SaaS, the per-tier `requireFeatureEntitlement(_,
 * "proactive")` gate then admits all paid plans (min `trial`) — see
 * `feature-entitlement.ts`.
 *
 * `requireEnabled` re-reads `resolveDeployMode()` inside `Effect.suspend` on
 * every run so the read stays within the effect lifecycle — a fault fails the
 * effect rather than throwing at construction time — and a runtime change to
 * `ATLAS_DEPLOY_MODE` propagates without restart. The denial message is the
 * shared `PROACTIVE_HOSTED_ONLY_MESSAGE` constant so the sync inline gate in
 * `admin-proactive.ts` can't drift from this one.
 */

import { Effect, Layer } from "effect";
import { resolveDeployMode } from "@atlas/api/lib/effect/deploy-mode";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import {
  ProactiveGate,
  PROACTIVE_HOSTED_ONLY_MESSAGE,
  type ProactiveGateShape,
} from "@atlas/api/lib/effect/services";

export const makeProactiveGateLive = (): ProactiveGateShape => ({
  requireEnabled: () =>
    Effect.suspend(() =>
      resolveDeployMode() === "saas"
        ? Effect.void
        : Effect.fail(new EnterpriseError(PROACTIVE_HOSTED_ONLY_MESSAGE)),
    ),
});

export const ProactiveGateLive: Layer.Layer<ProactiveGate> = Layer.sync(
  ProactiveGate,
  makeProactiveGateLive,
);
