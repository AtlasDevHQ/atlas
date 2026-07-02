/**
 * #3705 — SaaS tuning knobs promoted into the settings registry.
 *
 * Each knob below was env-only before this change. The contract being
 * verified is the registry precedence chain for these platform-scoped keys:
 *
 *   platform DB override > env var > registry default
 *
 * Uses the real settings module with the `_resetPool` + `setSetting`
 * injection pattern from settings.test.ts / agent-max-steps.test.ts, so the
 * full resolution path (not a mock of `getSettingAuto`) is exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getContactRpmLimit } from "@atlas/api/lib/contact";
import { getDemoRpmLimit, getDemoMaxSteps } from "@atlas/api/lib/demo";
import { getAbuseConfig } from "@atlas/api/lib/security/abuse";
import {
  resolveAccessTokenTtlSeconds,
  resolveRefreshTokenTtlSeconds,
} from "@atlas/api/lib/auth/server";
import { getPluginHealthCacheTtlMs } from "@atlas/api/lib/plugins/registry";
import {
  getBillingReconcileIntervalMs,
  DEFAULT_BILLING_RECONCILE_INTERVAL_MS,
} from "@atlas/api/lib/billing/reconcile-plan-tiers";
import {
  getUnclaimedGraceReapIntervalMs,
  DEFAULT_UNCLAIMED_GRACE_REAP_INTERVAL_MS,
} from "@atlas/api/lib/billing/reap-unclaimed-grace";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";

const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

// Keys touched here, so the env tier can be isolated per test.
const ENV_KEYS = [
  "ATLAS_CONTACT_RATE_LIMIT_RPM",
  "ATLAS_DEMO_RATE_LIMIT_RPM",
  "ATLAS_DEMO_MAX_STEPS",
  "ATLAS_ABUSE_QUERY_RATE",
  "ATLAS_ABUSE_ERROR_RATE",
  "ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS",
  "ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS",
  "ATLAS_BILLING_RECONCILE_INTERVAL_HOURS",
  "ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS",
] as const;

const origEnv = new Map<string, string | undefined>();
const origDbUrl = process.env.DATABASE_URL;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    origEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
  _resetSettingsCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = origEnv.get(k);
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
  _resetSettingsCache();
});

describe("contact form RPM — registry precedence (#3705)", () => {
  it("falls back to the registry default when nothing is set", () => {
    expect(getContactRpmLimit()).toBe(5);
  });

  it("reads the env var when no DB override exists", () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "20";
    expect(getContactRpmLimit()).toBe(20);
  });

  it("platform DB override wins over the env var", async () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "20";
    await setSetting("ATLAS_CONTACT_RATE_LIMIT_RPM", "7", "test");
    expect(getContactRpmLimit()).toBe(7);
  });
});

describe("demo knobs — registry precedence (#3705)", () => {
  it("default RPM + max steps when nothing is set", () => {
    expect(getDemoRpmLimit()).toBe(10);
    expect(getDemoMaxSteps()).toBe(10);
  });

  it("DB override wins over env for both knobs", async () => {
    process.env.ATLAS_DEMO_RATE_LIMIT_RPM = "99";
    process.env.ATLAS_DEMO_MAX_STEPS = "99";
    await setSetting("ATLAS_DEMO_RATE_LIMIT_RPM", "3", "test");
    await setSetting("ATLAS_DEMO_MAX_STEPS", "20", "test");
    expect(getDemoRpmLimit()).toBe(3);
    expect(getDemoMaxSteps()).toBe(20);
  });
});

describe("abuse thresholds — registry precedence (#3705)", () => {
  it("uses registry defaults when unset", () => {
    const cfg = getAbuseConfig();
    expect(cfg.queryRateLimit).toBe(200);
    expect(cfg.errorRateThreshold).toBeCloseTo(0.5);
  });

  it("DB override retunes thresholds without a redeploy", async () => {
    await setSetting("ATLAS_ABUSE_QUERY_RATE", "500", "test");
    await setSetting("ATLAS_ABUSE_ERROR_RATE", "0.8", "test");
    const cfg = getAbuseConfig();
    expect(cfg.queryRateLimit).toBe(500);
    expect(cfg.errorRateThreshold).toBeCloseTo(0.8);
  });

  it("the escalation cooldown still honors its allow-zero override", async () => {
    await setSetting("ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS", "0", "test");
    expect(getAbuseConfig().escalationCooldownMs).toBe(0);
  });
});

describe("OAuth token TTLs — boot-consumed, registry override (#3705)", () => {
  it("DB override wins over the injected env (override-only read)", async () => {
    await setSetting("ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS", "30", "test");
    await setSetting("ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS", "120", "test");
    // The injected env carries different values — the registry must win.
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "3600",
      } as NodeJS.ProcessEnv),
    ).toBe(30);
    expect(
      resolveRefreshTokenTtlSeconds({
        ATLAS_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "3600",
      } as NodeJS.ProcessEnv),
    ).toBe(120);
  });

  it("falls back to the injected env when no DB override exists", () => {
    expect(
      resolveAccessTokenTtlSeconds({
        ATLAS_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "45",
      } as NodeJS.ProcessEnv),
    ).toBe(45);
  });

  it("falls back to the default when neither is set", () => {
    expect(resolveAccessTokenTtlSeconds({} as NodeJS.ProcessEnv)).toBe(3600);
    expect(resolveRefreshTokenTtlSeconds({} as NodeJS.ProcessEnv)).toBe(2592000);
  });
});

describe("plugin health cache TTL — registry precedence (#3705)", () => {
  it("default when unset", () => {
    expect(getPluginHealthCacheTtlMs()).toBe(15000);
  });

  it("DB override wins over env", async () => {
    process.env.ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS = "99999";
    await setSetting("ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS", "5000", "test");
    expect(getPluginHealthCacheTtlMs()).toBe(5000);
  });
});

describe("billing scheduler cadences — registry precedence (#4130)", () => {
  it("falls back to the registry defaults when nothing is set (pre-#4130 cadence)", () => {
    expect(getBillingReconcileIntervalMs()).toBe(DEFAULT_BILLING_RECONCILE_INTERVAL_MS);
    expect(getBillingReconcileIntervalMs()).toBe(6 * 60 * 60 * 1000);
    expect(getUnclaimedGraceReapIntervalMs()).toBe(DEFAULT_UNCLAIMED_GRACE_REAP_INTERVAL_MS);
    expect(getUnclaimedGraceReapIntervalMs()).toBe(60 * 60 * 1000);
  });

  it("reads the env var when no DB override exists", () => {
    process.env.ATLAS_BILLING_RECONCILE_INTERVAL_HOURS = "12";
    process.env.ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS = "2";
    expect(getBillingReconcileIntervalMs()).toBe(12 * 60 * 60 * 1000);
    expect(getUnclaimedGraceReapIntervalMs()).toBe(2 * 60 * 60 * 1000);
  });

  it("platform DB override wins over the env var", async () => {
    process.env.ATLAS_BILLING_RECONCILE_INTERVAL_HOURS = "12";
    process.env.ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS = "12";
    await setSetting("ATLAS_BILLING_RECONCILE_INTERVAL_HOURS", "3", "test");
    await setSetting("ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS", "0.5", "test");
    expect(getBillingReconcileIntervalMs()).toBe(3 * 60 * 60 * 1000);
    expect(getUnclaimedGraceReapIntervalMs()).toBe(0.5 * 60 * 60 * 1000);
  });

  it("rejects non-positive or unparseable overrides (falls back to defaults)", async () => {
    await setSetting("ATLAS_BILLING_RECONCILE_INTERVAL_HOURS", "0", "test");
    await setSetting("ATLAS_UNCLAIMED_GRACE_REAP_INTERVAL_HOURS", "banana", "test");
    expect(getBillingReconcileIntervalMs()).toBe(DEFAULT_BILLING_RECONCILE_INTERVAL_MS);
    expect(getUnclaimedGraceReapIntervalMs()).toBe(DEFAULT_UNCLAIMED_GRACE_REAP_INTERVAL_MS);
  });
});
