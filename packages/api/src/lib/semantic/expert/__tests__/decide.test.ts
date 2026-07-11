/**
 * Unit tests for the decide seam (#4506) — the single owner of the semantic
 * Amendment `pending → approved | rejected` transition.
 *
 * Pins the claim-then-apply ordering and the compensation contract:
 *   - approve: claim → apply (from the STORED row) → stamp; `approved` is
 *     unreachable without a successful apply;
 *   - apply failure (incl. null/corrupt payload): release back to pending with
 *     the reason, rethrow — never a stamp, never a swallow;
 *   - reject: one atomic conditional update, no apply;
 *   - races: the losing concurrent decision gets `not_pending` and never
 *     triggers a second apply.
 *
 * The DB helpers are mocked statefully (synchronous conditional flips, like
 * the SQL's conditional UPDATEs); the apply module is mocked with the real
 * module's null-payload contract.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

interface Row {
  id: string;
  source_entity: string;
  connection_group_id: string | null;
  amendment_payload: Record<string, unknown> | null;
}

// Stateful DB model: `pending` holds unclaimed rows, `claimed` holds rows in
// the `applying` state keyed by id, each with the claim token (`claimed_at`)
// the claim minted. Conditional flips are synchronous, so interleaved async
// callers serialize exactly like the SQL's row-level conditional UPDATE, and
// stamp/release verify the token exactly like the SQL's `reviewed_at = $N`.
let pending = new Map<string, Row>();
let claimed = new Map<string, { row: Row; token: string }>();
let releaseReasons: Array<{ id: string; reason: string | null }> = [];
let stamped: string[] = [];
let rejected: string[] = [];
let callOrder: string[] = [];
let claimSeq = 0;
// Failure-injection switches.
let releaseThrows = false;
// When set, the apply seam raises a StaleBaselineError carrying this diff/hash
// — modeling a hash-carried claim whose baseline changed since render (#4511).
let applyStale: { diff: string; baselineHash: string } | null = null;
// Captures the review-integrity options threaded into the apply (#4511).
let lastApplyArgs: Record<string, unknown> | null = null;
// When set, the row's claim token is silently rewritten after the claim —
// modeling a stale-claim takeover between this decision's claim and stamp.
let takeoverAfterClaim = false;

void mock.module("@atlas/api/lib/db/internal", () => ({
  claimPendingAmendment: async (id: string, _orgId: string | null, _by: string) => {
    callOrder.push(`claim:${id}`);
    const row = pending.get(id);
    if (!row) return null;
    pending.delete(id);
    const token = `claim-${++claimSeq}`;
    claimed.set(id, { row, token });
    const returnedToken = token;
    if (takeoverAfterClaim) {
      claimed.set(id, { row, token: `claim-${++claimSeq}` });
    }
    return { ...row, claimed_at: returnedToken };
  },
  stampClaimedAmendmentApproved: async (id: string, claimedAt: string) => {
    callOrder.push(`stamp:${id}`);
    const held = claimed.get(id);
    if (!held || held.token !== claimedAt) return false;
    claimed.delete(id);
    stamped.push(id);
    return true;
  },
  releaseClaimedAmendment: async (id: string, claimedAt: string, reason: string | null) => {
    callOrder.push(`release:${id}`);
    if (releaseThrows) throw new Error("release exploded");
    const held = claimed.get(id);
    if (!held || held.token !== claimedAt) return false;
    claimed.delete(id);
    pending.set(id, held.row);
    releaseReasons.push({ id, reason });
    return true;
  },
  rejectPendingAmendment: async (id: string, _orgId: string | null, _by: string) => {
    callOrder.push(`reject:${id}`);
    if (!pending.delete(id)) return false;
    rejected.push(id);
    return true;
  },
}));

// Apply mock mirroring the REAL module's contract (unit-tested in
// apply-from-payload.test.ts): throws on a missing payload BEFORE any YAML
// mutation; otherwise records the applied identity.
let applyCalls: Array<Record<string, unknown>> = [];
let applyThrows: Error | null = null;
// The seam statically imports `StaleBaselineError` from `../diff` (real,
// unmocked). The apply mock raises the REAL class so the seam's `instanceof`
// check fires and routes it to the `stale` outcome (#4511).
import { StaleBaselineError } from "../diff";

void mock.module("../apply", () => ({
  applyAmendmentFromPayload: async (args: Record<string, unknown>) => {
    callOrder.push(`apply:${String(args.label)}`);
    lastApplyArgs = args;
    if (applyStale) {
      throw new StaleBaselineError({
        entityName: String(args.sourceEntity),
        diff: applyStale.diff,
        baselineHash: applyStale.baselineHash,
      });
    }
    if (applyThrows) throw applyThrows;
    if (!args.rawPayload) {
      throw new Error(
        `Amendment ${String(args.label)} has no amendment_payload — cannot apply its YAML change.`,
      );
    }
    applyCalls.push(args);
  },
  applyAmendmentToEntity: async () => {},
  applyAmendment: () => ({}),
  analysisResultFromStoredPayload: () => ({}),
  resolveAmendmentBaseline: async () => {
    throw new Error("not used by the seam");
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { decideAmendment } = await import("../decide");

function seedRow(id: string, overrides: Partial<Row> = {}): void {
  pending.set(id, {
    id,
    source_entity: "orders",
    connection_group_id: "eu_prod",
    amendment_payload: {
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "region", type: "string" },
    },
    ...overrides,
  });
}

function decide(
  id: string,
  decision: "approved" | "rejected",
  extra?: { expectedBaselineHash?: string; group?: string | null },
) {
  return decideAmendment({
    id,
    orgId: "org-1",
    decision,
    reviewedBy: "admin-1",
    requestId: "req-1",
    ...extra,
  });
}

beforeEach(() => {
  pending = new Map();
  claimed = new Map();
  releaseReasons = [];
  stamped = [];
  rejected = [];
  callOrder = [];
  claimSeq = 0;
  applyCalls = [];
  applyThrows = null;
  releaseThrows = false;
  takeoverAfterClaim = false;
  applyStale = null;
  lastApplyArgs = null;
});

describe("decideAmendment — approve (#4506)", () => {
  it("claims, applies from the STORED row, then stamps — in that order", async () => {
    seedRow("amd-1");

    const outcome = await decide("amd-1", "approved");

    expect(outcome).toEqual({ kind: "approved", id: "amd-1" });
    expect(callOrder).toEqual(["claim:amd-1", "apply:amd-1", "stamp:amd-1"]);
    // The apply consumed the claimed row's own identity — entity, group, and
    // payload come from the DB row, never a caller-supplied copy.
    expect(applyCalls[0]).toMatchObject({
      orgId: "org-1",
      sourceEntity: "orders",
      connectionGroupId: "eu_prod",
      label: "amd-1",
    });
    expect(stamped).toEqual(["amd-1"]);
  });

  it("returns not_pending without applying when no pending row exists", async () => {
    const outcome = await decide("absent", "approved");

    expect(outcome).toEqual({ kind: "not_pending", id: "absent" });
    expect(applyCalls).toHaveLength(0);
    expect(stamped).toHaveLength(0);
  });

  it("apply failure: releases the claim with the reason, rethrows, never stamps", async () => {
    seedRow("amd-2");
    applyThrows = new Error("version snapshot failed");

    await expect(decide("amd-2", "approved")).rejects.toThrow("version snapshot failed");

    expect(callOrder).toEqual(["claim:amd-2", "apply:amd-2", "release:amd-2"]);
    expect(stamped).toHaveLength(0);
    // Compensated back to pending with the visible reason.
    expect(pending.has("amd-2")).toBe(true);
    expect(releaseReasons).toEqual([{ id: "amd-2", reason: "version snapshot failed" }]);
  });

  it("null payload: error (rethrown), row released untouched back to pending — never a silent stamp", async () => {
    seedRow("amd-null", { amendment_payload: null });

    await expect(decide("amd-null", "approved")).rejects.toThrow("no amendment_payload");

    expect(stamped).toHaveLength(0);
    expect(applyCalls).toHaveLength(0);
    expect(pending.has("amd-null")).toBe(true);
    expect(releaseReasons[0].reason).toContain("no amendment_payload");
  });

  it("release failure still rethrows the ORIGINAL apply error (compensation is best-effort, logged)", async () => {
    seedRow("amd-3");
    applyThrows = new Error("apply exploded");
    releaseThrows = true;

    await expect(decide("amd-3", "approved")).rejects.toThrow("apply exploded");
    expect(stamped).toHaveLength(0);
  });

  it("reports not_pending when a takeover replaced the claim token mid-apply (apply already landed, idempotent)", async () => {
    // Models an apply that outlived the stale window: another decision
    // re-claimed the row (new token) while this one was mid-apply. The stamp
    // is conditional on THIS claim's token, so it must observe "claim lost" —
    // never stamp `approved` over the takeover's live claim.
    seedRow("amd-4");
    takeoverAfterClaim = true;

    const outcome = await decide("amd-4", "approved");

    expect(outcome).toEqual({ kind: "not_pending", id: "amd-4" });
    expect(applyCalls).toHaveLength(1);
    expect(stamped).toHaveLength(0);
    // The takeover's claim is still held — this decision didn't release it.
    expect(claimed.has("amd-4")).toBe(true);
  });
});

describe("decideAmendment — hash-carried claim + stale baseline (#4511)", () => {
  it("threads the hash + disambiguation group into the apply", async () => {
    seedRow("amd-hash");

    await decide("amd-hash", "approved", { expectedBaselineHash: "hash-xyz", group: "eu_prod" });

    expect(lastApplyArgs).toMatchObject({
      label: "amd-hash",
      expectedBaselineHash: "hash-xyz",
      disambiguationGroup: "eu_prod",
    });
  });

  it("stale baseline: returns `stale` with the fresh diff, releases the claim CLEANLY (no reason), never stamps", async () => {
    seedRow("amd-stale");
    applyStale = { diff: "--- a\n+++ b\n+region", baselineHash: "fresh-hash" };

    const outcome = await decide("amd-stale", "approved", { expectedBaselineHash: "old-hash" });

    expect(outcome).toEqual({
      kind: "stale",
      id: "amd-stale",
      diff: "--- a\n+++ b\n+region",
      baselineHash: "fresh-hash",
    });
    // Claimed, apply raised stale, claim released — but NOT stamped.
    expect(callOrder).toEqual(["claim:amd-stale", "apply:amd-stale", "release:amd-stale"]);
    expect(stamped).toHaveLength(0);
    // Released with a NULL reason — a changed baseline is not an apply failure,
    // so the queue must not show a scary `last_apply_error`.
    expect(releaseReasons).toEqual([{ id: "amd-stale", reason: null }]);
    // Back in the pending queue, ready for the confirming re-decide.
    expect(pending.has("amd-stale")).toBe(true);
  });

  it("still returns `stale` (with the fresh diff) even when the claim release throws", async () => {
    // The admin must get the fresh diff to confirm against even if the
    // best-effort release logging path fails — the release is compensation, not
    // the outcome.
    seedRow("amd-stale-rel");
    applyStale = { diff: "--- a\n+++ b\n+region", baselineHash: "fresh-hash" };
    releaseThrows = true;

    const outcome = await decide("amd-stale-rel", "approved", { expectedBaselineHash: "old-hash" });

    expect(outcome).toEqual({
      kind: "stale",
      id: "amd-stale-rel",
      diff: "--- a\n+++ b\n+region",
      baselineHash: "fresh-hash",
    });
    expect(stamped).toHaveLength(0);
  });

  it("confirming re-decide with the fresh hash applies (matching hash → no stale)", async () => {
    seedRow("amd-confirm");
    // The confirm carries the fresh hash; the apply no longer raises stale.
    applyStale = null;

    const outcome = await decide("amd-confirm", "approved", { expectedBaselineHash: "fresh-hash" });

    expect(outcome).toEqual({ kind: "approved", id: "amd-confirm" });
    expect(callOrder).toEqual(["claim:amd-confirm", "apply:amd-confirm", "stamp:amd-confirm"]);
    expect(lastApplyArgs).toMatchObject({ expectedBaselineHash: "fresh-hash" });
  });
});

describe("decideAmendment — reject (#4506)", () => {
  it("rejects atomically without ever touching the apply seam", async () => {
    seedRow("amd-5");

    const outcome = await decide("amd-5", "rejected");

    expect(outcome).toEqual({ kind: "rejected", id: "amd-5" });
    expect(callOrder).toEqual(["reject:amd-5"]);
    expect(applyCalls).toHaveLength(0);
    expect(rejected).toEqual(["amd-5"]);
  });

  it("returns not_pending when the row is absent or already decided", async () => {
    const outcome = await decide("absent", "rejected");
    expect(outcome).toEqual({ kind: "not_pending", id: "absent" });
  });
});

describe("decideAmendment — races (#4506)", () => {
  it("concurrent approves: exactly one applies and stamps; the loser gets not_pending", async () => {
    seedRow("amd-race");

    const [a, b] = await Promise.all([
      decide("amd-race", "approved"),
      decide("amd-race", "approved"),
    ]);

    const kinds = [a.kind, b.kind].toSorted();
    expect(kinds).toEqual(["approved", "not_pending"]);
    expect(applyCalls).toHaveLength(1);
    expect(stamped).toEqual(["amd-race"]);
  });

  it("approve racing reject: an applied change can never end up rejected", async () => {
    seedRow("amd-ar");

    const [approveOutcome, rejectOutcome] = await Promise.all([
      decide("amd-ar", "approved"),
      decide("amd-ar", "rejected"),
    ]);

    // Exactly one decision wins.
    expect([approveOutcome.kind, rejectOutcome.kind].toSorted()).toEqual(
      approveOutcome.kind === "approved" ? ["approved", "not_pending"] : ["not_pending", "rejected"],
    );
    // The impossible state: YAML applied AND row rejected.
    if (applyCalls.length > 0) {
      expect(rejected).toHaveLength(0);
      expect(stamped).toEqual(["amd-ar"]);
    } else {
      expect(rejected).toEqual(["amd-ar"]);
      expect(stamped).toHaveLength(0);
    }
  });

  it("reject racing reject: only one wins", async () => {
    seedRow("amd-rr");

    const outcomes = await Promise.all([decide("amd-rr", "rejected"), decide("amd-rr", "rejected")]);
    expect(outcomes.map((o) => o.kind).toSorted()).toEqual(["not_pending", "rejected"]);
    expect(rejected).toEqual(["amd-rr"]);
  });
});
