/**
 * Tests for `resolveInstallStatus` — slice 2 of #2738 (issue #2740).
 *
 * Pure function under test. Three orthogonal gates from ADR-0006 /
 * ADR-0007 layer in priority order:
 *
 *   1. coming_soon  (Atlas hasn't shipped it)        → trumps everything
 *   2. misconfigured (operator hasn't wired env vars / handler)
 *   3. plan-gate    (existing upsell logic)
 *
 * When all three gates pass the card resolves to `accessible` (no
 * install) or `connected` (install row exists). When the plan gate
 * fails but an install row exists the card resolves to
 * `configured_but_downgraded` so the user can still disconnect.
 *
 * The table below enumerates every combination of the five boolean-ish
 * input axes (2^5 = 32 rows). The final `assertNever` switch is the
 * compile-time exhaustiveness guard required by the slice's
 * acceptance criteria — adding a new CardState variant without
 * extending the switch breaks the build.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveInstallStatus,
  type CardState,
  type ResolveInstallStatusInput,
  type WorkspaceInstallInput,
} from "../install-status-machine";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const SOME_INSTALL: WorkspaceInstallInput = { installId: "default" };

function caseInput(opts: {
  status: "available" | "coming_soon";
  install: WorkspaceInstallInput | null;
  planAdmits: boolean;
  handlerRegistered: boolean;
  deployConfigured: boolean;
}): ResolveInstallStatusInput {
  return {
    catalogRow: { implementationStatus: opts.status },
    workspaceInstall: opts.install,
    planAdmits: opts.planAdmits,
    handlerRegistered: opts.handlerRegistered,
    deployConfigured: opts.deployConfigured,
  };
}

interface Case {
  name: string;
  input: ResolveInstallStatusInput;
  expected: CardState;
}

const cases: Case[] = [];

// ---------------------------------------------------------------------------
// Gate 1 — coming_soon dominates all other gates (16 rows)
// ---------------------------------------------------------------------------

for (const install of [null, SOME_INSTALL]) {
  for (const planAdmits of [false, true]) {
    for (const handlerRegistered of [false, true]) {
      for (const deployConfigured of [false, true]) {
        cases.push({
          name: `coming_soon dominates (install=${install ? "yes" : "no"}, plan=${planAdmits}, handler=${handlerRegistered}, deploy=${deployConfigured})`,
          input: caseInput({
            status: "coming_soon",
            install,
            planAdmits,
            handlerRegistered,
            deployConfigured,
          }),
          expected: "coming_soon",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gate 2 — misconfigured: status=available but handler/deploy unwired
// (12 rows: 3 broken-combos × 2 install × 2 plan)
// ---------------------------------------------------------------------------

const brokenDeployStates: Array<{ handlerRegistered: boolean; deployConfigured: boolean }> = [
  { handlerRegistered: false, deployConfigured: false },
  { handlerRegistered: false, deployConfigured: true },
  { handlerRegistered: true, deployConfigured: false },
];

for (const install of [null, SOME_INSTALL]) {
  for (const planAdmits of [false, true]) {
    for (const broken of brokenDeployStates) {
      cases.push({
        name: `misconfigured (install=${install ? "yes" : "no"}, plan=${planAdmits}, handler=${broken.handlerRegistered}, deploy=${broken.deployConfigured})`,
        input: caseInput({
          status: "available",
          install,
          planAdmits,
          handlerRegistered: broken.handlerRegistered,
          deployConfigured: broken.deployConfigured,
        }),
        expected: "misconfigured",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Gates 3 + happy paths — status=available, handler+deploy ready (4 rows)
// ---------------------------------------------------------------------------

cases.push({
  name: "upgrade_required: plan denies, no install",
  input: caseInput({
    status: "available",
    install: null,
    planAdmits: false,
    handlerRegistered: true,
    deployConfigured: true,
  }),
  expected: "upgrade_required",
});

cases.push({
  name: "configured_but_downgraded: plan denies, install present",
  input: caseInput({
    status: "available",
    install: SOME_INSTALL,
    planAdmits: false,
    handlerRegistered: true,
    deployConfigured: true,
  }),
  expected: "configured_but_downgraded",
});

cases.push({
  name: "accessible: plan admits, no install, deploy ready",
  input: caseInput({
    status: "available",
    install: null,
    planAdmits: true,
    handlerRegistered: true,
    deployConfigured: true,
  }),
  expected: "accessible",
});

cases.push({
  name: "connected: plan admits, install present, deploy ready",
  input: caseInput({
    status: "available",
    install: SOME_INSTALL,
    planAdmits: true,
    handlerRegistered: true,
    deployConfigured: true,
  }),
  expected: "connected",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveInstallStatus", () => {
  it("covers every combination of the 5 input axes exactly once (32 rows)", () => {
    expect(cases.length).toBe(32);
    const seenInputs = new Set<string>();
    for (const c of cases) {
      const key = JSON.stringify(c.input);
      expect(seenInputs.has(key)).toBe(false);
      seenInputs.add(key);
    }
  });

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveInstallStatus(c.input)).toBe(c.expected);
    });
  }

  it("the fixture reaches every CardState branch (exhaustiveness)", () => {
    const seen = new Set<CardState>(cases.map((c) => c.expected));

    // Listing every branch through a switch with an `assertNever`
    // default is the compile-time guard. Adding a new CardState
    // variant without adding an arm here breaks tsgo.
    const all: CardState[] = [
      "connected",
      "accessible",
      "coming_soon",
      "misconfigured",
      "upgrade_required",
      "configured_but_downgraded",
    ];
    for (const s of all) {
      switch (s) {
        case "connected":
        case "accessible":
        case "coming_soon":
        case "misconfigured":
        case "upgrade_required":
        case "configured_but_downgraded":
          break;
        default:
          assertNever(s);
      }
      expect(seen.has(s)).toBe(true);
    }
  });
});

function assertNever(value: never): never {
  throw new Error(`Unhandled CardState variant: ${String(value)}`);
}
