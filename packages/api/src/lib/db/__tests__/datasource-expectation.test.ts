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
  _resetDatasourceExpectationWarning,
} from "@atlas/api/lib/db/datasource-expectation";
import { _setConfigForTest } from "@atlas/api/lib/config";

describe("isDatasourceExpected", () => {
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
    expect(isDatasourceExpected()).toBe(true);
  });

  it("treats an empty env var as undeclared", () => {
    process.env.ATLAS_DATASOURCE_EXPECTED = "";
    expect(isDatasourceExpected()).toBe(true);
  });

  it("accepts false/0 as declaring no datasource is expected", () => {
    for (const value of ["false", "0", "FALSE", " false "]) {
      process.env.ATLAS_DATASOURCE_EXPECTED = value;
      expect(isDatasourceExpected()).toBe(false);
    }
  });

  it("accepts true/1 as declaring one IS expected", () => {
    for (const value of ["true", "1", "TRUE"]) {
      process.env.ATLAS_DATASOURCE_EXPECTED = value;
      expect(isDatasourceExpected()).toBe(true);
    }
  });

  // An unparseable declaration must fail toward the noisy answer, not the quiet
  // one — a typo'd `ATLAS_DATASOURCE_EXPECTED=fasle` should leave /health
  // degraded so the operator finds it, not green so they never look.
  it("resolves an unrecognized value to expected", () => {
    process.env.ATLAS_DATASOURCE_EXPECTED = "nope";
    expect(isDatasourceExpected()).toBe(true);
  });

  // The combination that matters, and the one a "treats it as undeclared"
  // implementation gets wrong: on a shared image whose config declares
  // `datasourceExpected: false`, an operator typing `ture` on the ONE service
  // that does need a datasource must not have the shared file answer for them.
  // Falling through to the config here would return false — a silent green on
  // the deployment whose operator was visibly trying to opt back in.
  it("an unrecognized value does NOT fall through to a config that says false", () => {
    process.env.ATLAS_DATASOURCE_EXPECTED = "ture";
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for this path
    _setConfigForTest({ datasourceExpected: false } as any);
    expect(isDatasourceExpected()).toBe(true);
  });

  // ATLAS_DEMO_DATA=true asks Atlas to serve analytics off DATABASE_URL, so it
  // IS a declaration that a datasource is expected. Reaching the health rollup
  // with it set and nothing resolved means provisioning failed (startup.ts
  // raises MISSING_DATASOURCE_URL as an ERROR for exactly this) — a coarse
  // "none expected" must not bury a failed Neon provision.
  it("ATLAS_DEMO_DATA=true outranks a declaration of not-expected", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.ATLAS_DATASOURCE_EXPECTED = "false";
    expect(isDatasourceExpected()).toBe(true);

    delete process.env.ATLAS_DATASOURCE_EXPECTED;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for this path
    _setConfigForTest({ datasourceExpected: false } as any);
    expect(isDatasourceExpected()).toBe(true);
  });

  it("reads the declaration from atlas.config.ts", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for this path
    _setConfigForTest({ datasourceExpected: false } as any);
    expect(isDatasourceExpected()).toBe(false);
  });

  it("treats an absent config field as undeclared, not as a declaration", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for this path
    _setConfigForTest({ deployMode: "self-hosted" } as any);
    expect(isDatasourceExpected()).toBe(true);
  });

  // api-staging runs the PROD atlas.config.ts (#3958) and differs only by env
  // vars, so the per-service var has to win in both directions.
  it("env true overrides a config file that says false", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for this path
    _setConfigForTest({ datasourceExpected: false } as any);
    process.env.ATLAS_DATASOURCE_EXPECTED = "true";
    expect(isDatasourceExpected()).toBe(true);
  });

  it("env false overrides a config file that says true", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for this path
    _setConfigForTest({ datasourceExpected: true } as any);
    process.env.ATLAS_DATASOURCE_EXPECTED = "false";
    expect(isDatasourceExpected()).toBe(false);
  });
});
