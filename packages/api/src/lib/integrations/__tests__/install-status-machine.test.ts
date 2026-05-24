/**
 * Exhaustive table coverage for `resolveInstallStatus`. The 32 rows
 * enumerate every combination of the 5 boolean-ish input axes; the
 * `ALL_CARD_STATES` table at the bottom is the compile-time guard that
 * forces a new `CardState` variant to extend the fixture.
 *
 * See `install-status-machine.ts` for the gate contract.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveInstallStatus,
  type CardState,
  type ResolveInstallStatusInput,
  type WorkspaceInstallInput,
} from "../install-status-machine";

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

function inputKey(input: ResolveInstallStatusInput): string {
  return [
    input.catalogRow.implementationStatus,
    input.workspaceInstall ? input.workspaceInstall.installId : "_none",
    input.planAdmits ? "plan" : "noplan",
    input.handlerRegistered ? "handler" : "nohandler",
    input.deployConfigured ? "deploy" : "nodeploy",
  ].join("|");
}

interface Case {
  name: string;
  input: ResolveInstallStatusInput;
  expected: CardState;
}

const cases: Case[] = [];

// Gate 1 — coming_soon dominates regardless of any other gate (16 rows).
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

// Gate 2 — status=available but handler/deploy unwired (12 rows).
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

// Gate 3 + happy paths — status=available, handler+deploy ready (4 rows).
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

// Compile-time exhaustiveness guard: `satisfies Record<CardState, true>`
// forces a new variant in `CardState` to add a key here, and the for-of
// loop below asserts the fixture reaches that key at least once.
const ALL_CARD_STATES = {
  connected: true,
  accessible: true,
  coming_soon: true,
  misconfigured: true,
  upgrade_required: true,
  configured_but_downgraded: true,
} as const satisfies Record<CardState, true>;

describe("resolveInstallStatus", () => {
  it("covers every combination of the 5 input axes exactly once (32 rows)", () => {
    expect(cases.length).toBe(32);
    const seenInputs = new Set<string>();
    for (const c of cases) {
      const key = inputKey(c.input);
      expect(seenInputs.has(key), `duplicate fixture row: ${key}`).toBe(false);
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
    for (const s of Object.keys(ALL_CARD_STATES) as CardState[]) {
      expect(seen.has(s), `no fixture row produces CardState=${s}`).toBe(true);
    }
  });
});
