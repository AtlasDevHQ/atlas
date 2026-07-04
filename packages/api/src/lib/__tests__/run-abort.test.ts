/**
 * #4294 — the in-process abortable-run registry behind the chat Stop button.
 * Pins the contract the stop route relies on: identity-guarded abort,
 * uniform `not_found` on mismatch/unknown/settled (no cross-tenant existence
 * leak), idempotent unregister, and one-shot abort.
 */
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import {
  registerAbortableRun,
  unregisterAbortableRun,
  abortRun,
  __clearAbortableRunsForTest,
} from "@atlas/api/lib/run-abort";

const OWNER = { userId: "u-1", orgId: "org-1" };

describe("run-abort registry (#4294)", () => {
  beforeEach(() => {
    __clearAbortableRunsForTest();
  });

  afterEach(() => {
    setSystemTime(); // restore real clock
  });

  test("aborts a registered run for the matching identity and fires the controller", () => {
    const controller = new AbortController();
    registerAbortableRun("run-1", { controller, ...OWNER });

    expect(controller.signal.aborted).toBe(false);
    expect(abortRun("run-1", OWNER)).toBe("aborted");
    expect(controller.signal.aborted).toBe(true);
  });

  test("a second abort of the same run is not_found (one-shot; treated as already finished)", () => {
    const controller = new AbortController();
    registerAbortableRun("run-1", { controller, ...OWNER });

    expect(abortRun("run-1", OWNER)).toBe("aborted");
    expect(abortRun("run-1", OWNER)).toBe("not_found");
  });

  test("an unknown run id is not_found", () => {
    expect(abortRun("run-missing", OWNER)).toBe("not_found");
  });

  test("identity mismatch is not_found and does NOT abort — a run id never confirms existence across a tenancy boundary", () => {
    const controller = new AbortController();
    registerAbortableRun("run-1", { controller, ...OWNER });

    expect(abortRun("run-1", { userId: "u-2", orgId: "org-1" })).toBe("not_found");
    expect(abortRun("run-1", { userId: "u-1", orgId: "org-2" })).toBe("not_found");
    expect(controller.signal.aborted).toBe(false);
    // The entry survives a rejected attempt — the real owner can still stop it.
    expect(abortRun("run-1", OWNER)).toBe("aborted");
  });

  test("null identities match only null identities (auth-mode 'none' runs are stoppable by that mode's callers only)", () => {
    const controller = new AbortController();
    registerAbortableRun("run-1", { controller, userId: null, orgId: null });

    expect(abortRun("run-1", OWNER)).toBe("not_found");
    expect(abortRun("run-1", { userId: null, orgId: null })).toBe("aborted");
  });

  test("entries older than the stale horizon are pruned lazily on register AND on abort", () => {
    const stale = new AbortController();
    registerAbortableRun("run-stale", { controller: stale, ...OWNER });

    // Jump past the 15-minute horizon; the next registry touch sweeps.
    setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    registerAbortableRun("run-fresh", { controller: new AbortController(), ...OWNER });

    expect(abortRun("run-stale", OWNER)).toBe("not_found");
    expect(stale.signal.aborted).toBe(false); // pruned, never aborted
    expect(abortRun("run-fresh", OWNER)).toBe("aborted");

    // The abort-side sweep too: a quiet instance (no new registrations)
    // still prunes when a stop request arrives.
    __clearAbortableRunsForTest();
    setSystemTime(); // back to real time
    registerAbortableRun("run-stale-2", { controller: new AbortController(), ...OWNER });
    setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    expect(abortRun("run-stale-2", OWNER)).toBe("not_found");
  });

  test("unregister is idempotent and makes the run unstoppable (settled)", () => {
    const controller = new AbortController();
    registerAbortableRun("run-1", { controller, ...OWNER });

    unregisterAbortableRun("run-1");
    unregisterAbortableRun("run-1");
    expect(abortRun("run-1", OWNER)).toBe("not_found");
    expect(controller.signal.aborted).toBe(false);
  });
});
