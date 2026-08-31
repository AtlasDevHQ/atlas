/**
 * The actions router registers the built-in executors by importing them (#5570).
 *
 * Its own file, deliberately: `actions.test.ts` `mock.module`s the handler, so
 * it cannot observe the real registry, and this pin needs a process where
 * nothing has registered anything yet. `bun test --parallel` gives each file a
 * fresh module registry, which is what makes the "before" assertion mean
 * something.
 *
 * ## What this is actually guarding
 *
 * The executors register at MODULE LOAD, and for a long moment in this change
 * nothing loaded them at boot: `buildRegistry({ includeActions: true })`
 * reaches the action modules through a lazy `await import("./actions")` that
 * only runs inside a chat turn. A process that restarted and received
 * `POST /actions/:id/approve` before serving an action-enabled turn would have
 * found an EMPTY registry and stranded the row at `approved` — reintroducing
 * the exact bug the type-keyed registry replaced, as a load-order accident,
 * with every unit test still green because every suite registers its own
 * executors explicitly.
 *
 * So the property under test is not "the modules can register" — that is pinned
 * per-module — but "importing the router is sufficient". Delete the
 * side-effect import from `routes/actions.ts` and this file fails.
 */

import { describe, it, expect } from "bun:test";
import {
  isActionTypeExecutable,
  getActionExecutorForType,
} from "@atlas/api/lib/tools/actions/handler";

// The dependency-free manifest — the same list `wireActionPlugins` consults to
// refuse a plugin claiming a built-in's type. Reading it here rather than
// re-typing the five strings is what makes the second test below a real
// two-way pin: the manifest must name exactly what the modules register, or a
// plugin could claim a type the refusal check does not know about.
import { BUILTIN_ACTION_TYPES } from "@atlas/api/lib/tools/actions/manifest";

describe("actions router — built-in executor registration at load", () => {
  it("⭐ importing the router is enough to make every built-in type executable", async () => {
    // Nothing has loaded an action module in this process yet.
    for (const actionType of BUILTIN_ACTION_TYPES) {
      expect(isActionTypeExecutable(actionType)).toBe(false);
    }

    await import("@atlas/api/api/routes/actions");

    for (const actionType of BUILTIN_ACTION_TYPES) {
      expect(isActionTypeExecutable(actionType)).toBe(true);
      expect(getActionExecutorForType(actionType)).toBeTypeOf("function");
    }
  });

  it("the registered types are the ones the AtlasActions declare", async () => {
    // Guards the other direction: a module that registered under a typo would
    // pass the check above only because the literal above carried the same
    // typo. `ACTION_TOOLS` is the list `buildRegistry` iterates.
    const { ACTION_TOOLS } = await import("@atlas/api/lib/tools/actions/index");

    const declared = ACTION_TOOLS.map((a: { actionType: string }) => a.actionType).sort();
    expect(declared).toEqual([...BUILTIN_ACTION_TYPES].sort());
    // ...and nothing registered a type the manifest does not name, which is
    // what `wireActionPlugins`' refusal check depends on being true.
    for (const actionType of declared) {
      expect(isActionTypeExecutable(actionType)).toBe(true);
    }
  });
});
