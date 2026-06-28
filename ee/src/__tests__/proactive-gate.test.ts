/**
 * Unit tests for `makeProactiveGateLive` — the deployment-level proactive
 * availability gate (#3999).
 *
 * Proactive is a hosted-SaaS-only feature: the gate admits a request iff
 * `resolveDeployMode() === "saas"` and fails with `EnterpriseError` on every
 * self-hosted deployment — *including self-hosted enterprise* (the #3999
 * exclusion). The route tests exercise this through the `ProactiveGate` Tag;
 * this pins the live shape's predicate directly.
 *
 * Mocks mirror `deploy-mode.test.ts` (the gate's predicate is `resolveDeployMode`):
 * `getConfig` drives the enterprise flag, `hasInternalDB` the auto-mode probe,
 * and the logger is stubbed to keep the services import chain quiet.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect, Either } from "effect";

// ── Mutable mock state ──────────────────────────────────────────────
let enterpriseEnabledConfig: boolean | undefined = true;
let _hasInternalDB = true;

// ── Register all mocks before any dynamic import ────────────────────
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () =>
    enterpriseEnabledConfig === undefined
      ? null
      : { enterprise: { enabled: enterpriseEnabledConfig } },
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => _hasInternalDB,
  getInternalDB: () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: async () => [],
  internalExecute: () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import under test AFTER mocks are installed. `EnterpriseError` is imported
// from the same core module the gate constructs, so `instanceof` is identity.
const { makeProactiveGateLive } = await import("../proactive-gate");
const { EnterpriseError } = await import("@atlas/api/lib/effect/errors");

/** Run `requireEnabled` to an Either — Right(void) = admitted, Left(err) = denied. */
function runGate() {
  return Effect.runSync(Effect.either(makeProactiveGateLive().requireEnabled()));
}

describe("makeProactiveGateLive — hosted-SaaS-only availability gate (#3999)", () => {
  beforeEach(() => {
    enterpriseEnabledConfig = true;
    _hasInternalDB = true;
    delete process.env.ATLAS_DEPLOY_MODE;
    delete process.env.ATLAS_ENTERPRISE_ENABLED;
    // `auto` short-circuits to self-hosted under development; clear it so the
    // saas cases aren't flipped by an ambient repo `.env`.
    delete process.env.ATLAS_DEPLOY_ENV;
  });

  it("admits when deploy mode resolves to saas (enterprise enabled)", () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(Either.isRight(runGate())).toBe(true);
  });

  it("denies with EnterpriseError on explicit self-hosted, even with enterprise enabled (#3999 SaaS-exclusivity)", () => {
    // The new exclusion: a self-hosted *enterprise* box (EE on) no longer gets
    // proactive. Without #3999 the prior `isEnterpriseEnabled()` gate admitted it.
    process.env.ATLAS_DEPLOY_MODE = "self-hosted";
    enterpriseEnabledConfig = true;
    const r = runGate();
    expect(Either.isLeft(r)).toBe(true);
    if (Either.isLeft(r)) expect(r.left).toBeInstanceOf(EnterpriseError);
  });

  it("denies when saas is requested but enterprise is disabled (resolveDeployMode falls back to self-hosted)", () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    enterpriseEnabledConfig = false;
    expect(Either.isLeft(runGate())).toBe(true);
  });

  it("denies in auto mode on a typical self-hosted box (no internal DB)", () => {
    // No ATLAS_DEPLOY_MODE → auto. Enterprise on but no internal DB → self-hosted.
    enterpriseEnabledConfig = true;
    _hasInternalDB = false;
    expect(Either.isLeft(runGate())).toBe(true);
  });
});
