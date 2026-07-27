/**
 * #4854 — resolution of "is a process-level analytics datasource expected on
 * this deployment?".
 *
 * The route-level contract (what /health does with the answer) is pinned in
 * `api/__tests__/health.test.ts`. This file pins the resolution itself: the
 * precedence between the per-service env var and the shared config file, and —
 * the load-bearing one — that an undeclared deployment resolves to EXPECTED, so
 * a missing datasource keeps degrading rather than silently reading green.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isDatasourceExpected,
  resolveDatasourceExpectation,
  datasourceExpectationWarning,
  _resetDatasourceExpectationWarning,
} from "@atlas/api/lib/db/datasource-expectation";
import { _setConfigForTest } from "@atlas/api/lib/config";

// NB the warn-ONCE latch is deliberately not pinned. Observing it needs a
// `mock.module("@atlas/api/lib/logger")`, and mocking createLogger process-wide
// hangs this file — pino loggers carry prototype methods a spread drops, and
// every module in the `lib/config` graph resolves its logger at import time.
// The latch governs log volume, not behaviour: `recognized` is returned on
// every call regardless, and that IS pinned below and surfaced on /health.

describe("resolveDatasourceExpectation", () => {
  const origExpected = process.env.ATLAS_DATASOURCE_EXPECTED;
  const origDemoData = process.env.ATLAS_DEMO_DATA;

  beforeEach(() => {
    delete process.env.ATLAS_DATASOURCE_EXPECTED;
    delete process.env.ATLAS_DEMO_DATA;
    _setConfigForTest(null);
    _resetDatasourceExpectationWarning();
  });

  afterEach(() => {
    if (origExpected !== undefined) process.env.ATLAS_DATASOURCE_EXPECTED = origExpected;
    else delete process.env.ATLAS_DATASOURCE_EXPECTED;
    if (origDemoData !== undefined) process.env.ATLAS_DEMO_DATA = origDemoData;
    else delete process.env.ATLAS_DEMO_DATA;
    _setConfigForTest(null);
    _resetDatasourceExpectationWarning();
  });

  // The default is the whole safety property: it is what keeps a self-hosted
  // box that forgot ATLAS_DATASOURCE_URL degrading on /health.
  it("defaults to expected when nothing is declared", () => {
    expect(resolveDatasourceExpectation()).toEqual({
      expected: true,
      source: "default",
      recognized: true,
    });
  });

  it("treats an empty env var as undeclared", () => {
    process.env.ATLAS_DATASOURCE_EXPECTED = "";
    expect(resolveDatasourceExpectation().source).toBe("default");
  });

  for (const value of ["false", "0", "FALSE", " false "]) {
    it(`accepts ${JSON.stringify(value)} as declaring no datasource is expected`, () => {
      process.env.ATLAS_DATASOURCE_EXPECTED = value;
      expect(resolveDatasourceExpectation()).toEqual({
        expected: false,
        source: "env",
        recognized: true,
      });
    });
  }

  for (const value of ["true", "1", "TRUE"]) {
    it(`accepts ${JSON.stringify(value)} as declaring one IS expected`, () => {
      process.env.ATLAS_DATASOURCE_EXPECTED = value;
      expect(resolveDatasourceExpectation()).toEqual({
        expected: true,
        source: "env",
        recognized: true,
      });
    });
  }

  // An unparseable declaration must fail toward the noisy answer, not the quiet
  // one — a typo'd `ATLAS_DATASOURCE_EXPECTED=fasle` should leave /health
  // degraded so the operator finds it, not green so they never look.
  it("resolves an unrecognized value to expected, and says it was unrecognized", () => {
    process.env.ATLAS_DATASOURCE_EXPECTED = "nope";
    expect(resolveDatasourceExpectation()).toEqual({
      expected: true,
      source: "env-unrecognized",
      recognized: false,
    });
  });

  // The combination that matters, and the one a "treats it as undeclared"
  // implementation gets wrong: on a shared image whose config declares
  // `datasourceExpected: false`, an operator typing `ture` on the ONE service
  // that does need a datasource must not have the shared file answer for them.
  // Falling through to the config here would return false — a silent green on
  // the deployment whose operator was visibly trying to opt back in.
  it("an unrecognized value does NOT fall through to a config that says false", () => {
    process.env.ATLAS_DATASOURCE_EXPECTED = "ture";
    _setConfigForTest({ datasourceExpected: false });
    expect(resolveDatasourceExpectation().expected).toBe(true);
  });

  // ATLAS_DEMO_DATA=true asks Atlas to serve analytics off DATABASE_URL, so it
  // IS a declaration that a datasource is expected. Reaching the health rollup
  // with it set and nothing resolved means provisioning failed (startup.ts
  // raises MISSING_DATASOURCE_URL as an ERROR for exactly this) — a coarse
  // "none expected" must not bury a failed Neon provision.
  it("ATLAS_DEMO_DATA=true outranks an env declaration of not-expected", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.ATLAS_DATASOURCE_EXPECTED = "false";
    expect(resolveDatasourceExpectation()).toEqual({
      expected: true,
      source: "demo-data",
      recognized: true,
    });
  });

  it("ATLAS_DEMO_DATA=true outranks a config declaration of not-expected", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    _setConfigForTest({ datasourceExpected: false });
    expect(resolveDatasourceExpectation().expected).toBe(true);
  });

  it("reads the declaration from atlas.config.ts", () => {
    _setConfigForTest({ datasourceExpected: false });
    expect(resolveDatasourceExpectation()).toEqual({
      expected: false,
      source: "config",
      recognized: true,
    });
  });

  it("treats an absent config field as undeclared, not as a declaration", () => {
    _setConfigForTest({ deployMode: "self-hosted" });
    expect(resolveDatasourceExpectation()).toEqual({
      expected: true,
      source: "default",
      recognized: true,
    });
  });

  // api-staging runs the PROD atlas.config.ts (#3958) and differs only by env
  // vars, so the per-service var has to win in both directions.
  it("env true overrides a config file that says false", () => {
    _setConfigForTest({ datasourceExpected: false });
    process.env.ATLAS_DATASOURCE_EXPECTED = "true";
    expect(resolveDatasourceExpectation().expected).toBe(true);
  });

  it("env false overrides a config file that says true", () => {
    _setConfigForTest({ datasourceExpected: true });
    process.env.ATLAS_DATASOURCE_EXPECTED = "false";
    expect(resolveDatasourceExpectation().expected).toBe(false);
  });

  it("resolves against an explicitly passed config instead of the singleton", () => {
    _setConfigForTest({ datasourceExpected: false });
    expect(resolveDatasourceExpectation(null).expected).toBe(true);
  });

});

describe("isDatasourceExpected", () => {
  it("is the boolean projection of the full resolution", () => {
    expect(isDatasourceExpected()).toBe(resolveDatasourceExpectation().expected);
  });
});

describe("datasourceExpectationWarning", () => {
  it("is undefined for a recognized resolution", () => {
    expect(
      datasourceExpectationWarning({ expected: true, source: "default", recognized: true }),
    ).toBeUndefined();
  });

  it("explains an unrecognized declaration without echoing the value", () => {
    const warning = datasourceExpectationWarning({
      expected: true,
      source: "env-unrecognized",
      recognized: false,
    });
    expect(warning).toContain("ATLAS_DATASOURCE_EXPECTED");
    expect(warning).toContain("expecting an analytics datasource");
    // /health is public and unauthenticated, and the value is operator-supplied
    // — it belongs in the server log, not in the response body.
    expect(warning).not.toContain("nope");
  });
});
